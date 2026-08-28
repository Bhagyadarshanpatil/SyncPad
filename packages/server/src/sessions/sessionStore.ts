/**
 * In-memory session store.
 *
 * Each document gets one SessionState object:
 * - A CRDTDocument that holds the server's authoritative oplog + branch.
 * - A Set of connected WebSocket clients.
 *
 * The server is the merge authority: every op that arrives here is
 * integrated into the server's document and then broadcast to all other clients.
 */

import type { WebSocket } from 'ws'
import { CRDTDocument, type WireOp, type VersionMap, type PeerInfo } from '@syncpad/egwalker-core'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConnectedPeer {
  ws: WebSocket
  agentId: string
  userId?: string
  name: string
  picture?: string
  color: string
  cursor?: number
}

export interface SessionState {
  docId: string
  /** The authoritative server document. */
  doc: CRDTDocument
  /** All connected WebSocket clients. */
  peers: Map<string, ConnectedPeer> // agentId → peer
}

// ─── Store ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>()

export function getSession(docId: string): SessionState | undefined {
  return sessions.get(docId)
}

export function getOrCreateSession(docId: string): SessionState {
  let session = sessions.get(docId)
  if (!session) {
    session = {
      docId,
      doc: new CRDTDocument(`server-${docId}`),
      peers: new Map(),
    }
    sessions.set(docId, session)
  }
  return session
}

export function deleteSession(docId: string): void {
  sessions.delete(docId)
}

export function getAllSessions(): SessionState[] {
  return Array.from(sessions.values())
}

// ─── Peer management ──────────────────────────────────────────────────────────

export function addPeer(session: SessionState, peer: ConnectedPeer): void {
  session.peers.set(peer.agentId, peer)
}

export function removePeer(session: SessionState, agentId: string): void {
  session.peers.delete(agentId)
  if (session.peers.size === 0) {
    // Keep the session alive (in-memory) for 5 minutes in case they reconnect.
    // In production, you'd also free memory if idle too long.
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getPeersInfo(session: SessionState): PeerInfo[] {
  return Array.from(session.peers.values()).map(p => ({
    agentId: p.agentId,
    userId: p.userId,
    name: p.name,
    picture: p.picture,
    color: p.color,
    cursor: p.cursor,
  }))
}

/**
 * Broadcast a message to all peers in a session EXCEPT the sender.
 */
export function broadcast(
  session: SessionState,
  message: string,
  excludeAgentId?: string,
): void {
  for (const [agentId, peer] of session.peers) {
    if (agentId === excludeAgentId) continue
    if (peer.ws.readyState === 1 /* OPEN */) {
      peer.ws.send(message)
    }
  }
}

/**
 * Send a message to a specific peer.
 */
export function sendToPeer(session: SessionState, agentId: string, message: string): void {
  const peer = session.peers.get(agentId)
  if (peer && peer.ws.readyState === 1) {
    peer.ws.send(message)
  }
}
