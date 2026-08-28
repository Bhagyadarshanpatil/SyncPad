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

export function registerWsHandler(app: FastifyInstance, db: DB): void {
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
              console.log(`[ws] ${msg.type.toUpperCase()} docId=${msg.docId} ops=${msg.ops.length} from=${currentAgentId}`)
              await handleOps(socket, db, msg.docId, msg.ops, currentAgentId)
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

  const peer: ConnectedPeer = { ws: socket, agentId, userId, name, picture, color }

  // Dedup by userId: if this Google user already has a live connection, close it.
  if (userId) {
    for (const [existingAgentId, existingPeer] of session.peers) {
      if (existingPeer.userId === userId) {
        console.log(`[ws] Replacing old connection for userId=${userId} (agentId=${existingAgentId})`)
        existingPeer.ws.close()
        session.peers.delete(existingAgentId)
        break
      }
    }
  }

  addPeer(session, peer)
  onJoined(docId, agentId)

  // Send catch-up ops the client is missing.
  const catchupOps = await getCatchupOps(db, docId, knownVersions)
  if (catchupOps.length > 0) {
    send(socket, { type: 'catchup', docId, ops: catchupOps })
  }

  // Send ACK of join + current peer list to joining client.
  send(socket, { type: 'peers', docId, peers: getPeersInfo(session) })

  // Announce new peer to all others.
  broadcast(
    session,
    JSON.stringify({ type: 'peers', docId, peers: getPeersInfo(session) } satisfies ServerMessage),
    agentId,
  )
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
    broadcast(
      session,
      JSON.stringify({
        type: 'ops',
        docId,
        ops: newOps,
        fromAgent: senderAgentId,
      } satisfies ServerMessage),
      senderAgentId,
    )
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
    if (msg.picture) peer.picture = msg.picture
  }

  broadcast(
    session,
    JSON.stringify({
      type: 'cursor',
      docId,
      agentId,
      cursor: msg.cursor,
      name: msg.name,
      picture: msg.picture,
    } satisfies ServerMessage),
    agentId,
  )
}
