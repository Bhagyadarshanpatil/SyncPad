/**
 * WebSocket message router.
 *
 * Handles all incoming client messages and dispatches to the appropriate
 * session/merge/broadcast logic.
 *
 * Message types handled:
 *   join    → load doc from DB, send catch-up, announce peer
 *   ops     → merge into server doc, broadcast to others
 *   catchup → same as ops but for bulk offline catch-up
 *   ping    → update cursor position, relay to others
 */

import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { FastifyRequest } from 'fastify'
import {
  type ClientMessage,
  type ServerMessage,
  type WireOp,
  encodeWireOps,
  decodeOpLog
} from '@syncpad/egwalker-core'
import type { DB } from '../db/queries.js'
import { ensureDocumentLoaded } from '../sessions/sessionManager.js'
import {
  addPeer,
  removePeer,
  broadcast,
  sendToPeer,
  getPeersInfo,
  getSession,
  type ConnectedPeer,
  type SessionState,
} from '../sessions/sessionStore.js'
import { applyRemoteOps, getCatchupOps } from './mergeEngine.js'

// Helper to convert Uint8Array to base64
function toBase64(arr: Uint8Array): string {
  return Buffer.from(arr).toString('base64')
}

// Helper to convert base64 to Uint8Array
function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

declare module 'fastify' {
  interface FastifyInstance {
    sessions: Map<string, SessionState>
  }
}

// ─── Message helpers ──────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg))
  }
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage
  } catch {
    return null
  }
}

// ─── Handler registration ─────────────────────────────────────────────────────

import { v4 as uuid } from 'uuid'
import { getLocalPeersInfo } from '../sessions/sessionStore.js'

const INSTANCE_ID = uuid()
let isListening = false
let globalSql: any = null

function publishEvent(docId: string, payload: any) {
  if (globalSql) {
    globalSql.notify('syncpad_events', JSON.stringify({ ...payload, instanceId: INSTANCE_ID, docId }))
  }
}

export function registerWsHandler(app: FastifyInstance, db: DB, sql: any): void {
  globalSql = sql
  if (!isListening && sql) {
    isListening = true
    sql.listen('syncpad_events', (rawPayload: string) => {
      try {
        const payload = JSON.parse(rawPayload)
        if (payload.instanceId === INSTANCE_ID) return // Ignore own events

        const session = app.sessions?.get(payload.docId)
        if (!session) return

        if (payload.type === 'sync_peers') {
          const isNewInstance = !session.remotePeers.has(payload.instanceId)
          const now = Date.now()
          payload.peers.forEach((p: any) => p.lastSeen = now)
          session.remotePeers.set(payload.instanceId, payload.peers)
          // Broadcast merged peer list to local peers
          broadcast(
            session,
            JSON.stringify({ type: 'peers', docId: payload.docId, peers: getPeersInfo(session) })
          )
          
          // Let the new instance know about our local peers
          if (isNewInstance && session.peers.size > 0) {
            publishEvent(payload.docId, { type: 'sync_peers', peers: getLocalPeersInfo(session) })
          }
        } else if (payload.type === 'broadcast') {
          try {
            const parsedMsg = JSON.parse(payload.message)
            if (parsedMsg.type === 'ops' && parsedMsg.ops) {
              // Apply remote ops to server memory without persisting (since sender already persisted)
              applyRemoteOps(db, session, parsedMsg.ops, false).catch(console.error)
            } else if (parsedMsg.type === 'cursor') {
              // Update lastSeen for remote peers
              const peersForInstance = session.remotePeers.get(payload.instanceId)
              if (peersForInstance) {
                const peer = peersForInstance.find(p => p.agentId === parsedMsg.agentId)
                if (peer) peer.lastSeen = Date.now()
              }
            }
          } catch (e) {
            console.error('Failed to parse broadcast message for ops application', e)
          }
          // Relay the message to all local peers
          broadcast(session, payload.message, payload.excludeAgentId)
        }
      } catch (e) {
        console.error('Error handling pubsub message:', e)
      }
    })
    
    // Periodically prune ghost peers that stopped sending pings (e.g. from crashed instances or dropped TCP connections)
    setInterval(() => {
      if (!app.sessions) return
      const now = Date.now()
      for (const session of app.sessions.values()) {
        let changed = false
        
        // Prune remote ghosts
        for (const [instanceId, peers] of session.remotePeers.entries()) {
          const activePeers = peers.filter(p => !p.lastSeen || (now - p.lastSeen < 15000))
          if (activePeers.length !== peers.length) {
            if (activePeers.length === 0) {
              session.remotePeers.delete(instanceId)
            } else {
              session.remotePeers.set(instanceId, activePeers)
            }
            changed = true
          }
        }
        
        if (changed) {
          broadcast(
            session,
            JSON.stringify({ type: 'peers', docId: session.docId, peers: getPeersInfo(session) })
          )
        }
        
        // Prune local ghosts (silently dropped TCP connections)
        for (const [agentId, peer] of session.peers.entries()) {
          if (peer.lastSeen && now - peer.lastSeen > 15000) {
            console.log(`[ws] Pruning ghost local peer ${agentId}`)
            peer.ws.close() // This triggers the 'close' event handler to clean up and broadcast
          }
        }
      }
    }, 5000)
  }

  app.get(
    '/ws',
    { websocket: true },
    async (connection: any, req: FastifyRequest) => {
      const socket: WebSocket = connection.socket
      // Each connection starts un-joined; we track state here.
      let currentDocId: string | null = null
      let currentAgentId: string | null = null

      // ── Message dispatch ────────────────────────────────────────────────────
      socket.on('message', async (rawMsg: Buffer) => {
        const msg = parseMessage(rawMsg.toString('utf-8'))
        if (!msg) {
          send(socket, { type: 'error', message: 'Invalid JSON' })
          return
        }

        try {
          switch (msg.type) {
            case 'join':
              console.log(`[ws] JOIN docId=${msg.docId} agentId=${msg.agentId}`)
              await handleJoin(socket, db, msg, (docId, agentId) => {
                currentDocId = docId
                currentAgentId = agentId
              })
              break

            case 'ops':
            case 'catchup':
              if (!currentDocId || !currentAgentId) {
                console.warn(`[ws] ${msg.type.toUpperCase()} received before join`)
                send(socket, { type: 'error', message: 'Not joined to a document' })
                return
              }
              
              let opsToProcess: WireOp[] = []
              if ('encoding' in msg && msg.encoding === 'binary' && msg.payload) {
                const buffer = fromBase64(msg.payload)
                opsToProcess = decodeOpLog(buffer)
                console.log(`[ws] CATCHUP (binary) docId=${msg.docId} ops=${opsToProcess.length} from=${currentAgentId}`)
              } else if ('ops' in msg && msg.ops) {
                opsToProcess = msg.ops
                console.log(`[ws] ${msg.type.toUpperCase()} docId=${msg.docId} ops=${opsToProcess.length} from=${currentAgentId}`)
              }
              
              if (opsToProcess.length > 0) {
                await handleOps(socket, db, msg.docId, opsToProcess, currentAgentId)
              }
              break

            case 'ping':
              if (!currentDocId || !currentAgentId) return
              handlePing(currentDocId, currentAgentId, msg)
              break
          }
        } catch (err) {
          console.error('[ws] Error handling message:', err)
          send(socket, { type: 'error', message: 'Internal server error' })
        }
      })

      // ── Cleanup on disconnect ───────────────────────────────────────────────
      socket.on('close', () => {
        if (currentDocId && currentAgentId) {
          const session = app.sessions?.get(currentDocId)
          if (session) {
            removePeer(session, currentAgentId)
            // Notify remaining peers.
            broadcast(
              session,
              JSON.stringify({
                type: 'peers',
                docId: currentDocId,
                peers: getPeersInfo(session),
              } satisfies ServerMessage),
            )
            publishEvent(currentDocId, { type: 'sync_peers', peers: getLocalPeersInfo(session) })
          }
        }
      })
    },
  )
}

// ─── Handler implementations ──────────────────────────────────────────────────

import { OAuth2Client } from 'google-auth-library'

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

async function handleJoin(
  socket: WebSocket,
  db: DB,
  msg: Extract<ClientMessage, { type: 'join' }>,
  onJoined: (docId: string, agentId: string) => void,
): Promise<void> {
  const { docId, agentId, knownVersions, token } = msg

  // Load (or create) the session.
  const session = await ensureDocumentLoaded(db, docId)

  let name: string
  let color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0') // Random color for cursor
  let userId: string
  let picture: string | undefined

  if (!token || !process.env.GOOGLE_CLIENT_ID) {
    console.warn(`[auth] Missing token or GOOGLE_CLIENT_ID for agent ${agentId}`)
    send(socket, { type: 'error', message: 'Authentication required' })
    socket.close()
    return
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    if (!payload || !payload.sub || !payload.name) {
      throw new Error('Invalid token payload')
    }
    userId = payload.sub
    name = payload.name
    picture = payload.picture
  } catch (err) {
    console.warn(`[auth] Invalid Google token for agent ${agentId}:`, err)
    send(socket, { type: 'error', message: 'Invalid authentication token' })
    socket.close()
    return
  }

  const peer: ConnectedPeer = { ws: socket, agentId, userId, name, picture, color, lastSeen: Date.now() }



  addPeer(session, peer)
  onJoined(docId, agentId)

  // Send catch-up ops the client is missing.
  const catchupOps = await getCatchupOps(db, docId, knownVersions)
  if (catchupOps.length > 0) {
    const encoded = encodeWireOps(catchupOps)
    send(socket, {
      type: 'catchup',
      docId,
      encoding: 'binary',
      payload: toBase64(encoded.buffer)
    })
  }

  // Send ACK of join + current peer list to joining client.
  send(socket, { type: 'peers', docId, peers: getPeersInfo(session) })

  // Announce new peer to all others.
  broadcast(
    session,
    JSON.stringify({ type: 'peers', docId, peers: getPeersInfo(session) } satisfies ServerMessage),
    agentId,
  )
  publishEvent(docId, { type: 'sync_peers', peers: getLocalPeersInfo(session) })
}

async function handleOps(
  socket: WebSocket,
  db: DB,
  docId: string,
  wireOps: WireOp[],
  senderAgentId: string,
): Promise<void> {
  const session = await ensureDocumentLoaded(db, docId)
  if (!session) return

  const { newOps } = await applyRemoteOps(db, session, wireOps)

  // ACK to sender.
  send(socket, {
    type: 'ack',
    docId,
    opIds: newOps.map(op => [op.agentId, op.seq]),
  })

  // Broadcast to all other clients.
  if (newOps.length > 0) {
    const opsMsg = JSON.stringify({
      type: 'ops',
      docId,
      ops: newOps,
      fromAgent: senderAgentId,
    } satisfies ServerMessage)
    broadcast(session, opsMsg, senderAgentId)
    publishEvent(docId, { type: 'broadcast', message: opsMsg, excludeAgentId: senderAgentId })
  }
}

function handlePing(
  docId: string,
  agentId: string,
  msg: Extract<ClientMessage, { type: 'ping' }>,
): void {
  const session = getSession(docId)
  if (!session) return

  const peer = session.peers.get(agentId)
  if (peer) {
    peer.cursor = msg.cursor
    peer.name = msg.name
    peer.lastSeen = Date.now()
    if (msg.picture) peer.picture = msg.picture
  }

  const cursorMsg = JSON.stringify({
    type: 'cursor',
    docId,
    agentId,
    cursor: msg.cursor,
    name: msg.name,
    picture: msg.picture,
  } satisfies ServerMessage)
  broadcast(session, cursorMsg, agentId)
  publishEvent(docId, { type: 'broadcast', message: cursorMsg, excludeAgentId: agentId })
}
