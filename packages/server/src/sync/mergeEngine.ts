/**
 * Server-side merge engine.
 *
 * Receives remote WireOps, integrates them into the authoritative
 * server document, persists them to PostgreSQL, detects critical versions,
 * and returns the ops to broadcast to other clients.
 */

import {
  pushRemoteOp,
  wireOpToRemoteOp,
  checkoutFancy,
  detectCriticalVersion,
  type WireOp,
  type VersionMap,
} from '@syncpad/egwalker-core'
import type { DB } from '../db/queries.js'
import { insertOps, getMissingOps, upsertCriticalVersion } from '../db/queries.js'
import type { SessionState } from '../sessions/sessionStore.js'

// ─── Apply remote ops ─────────────────────────────────────────────────────────

export interface MergeResult {
  /** The ops that were actually new (not already known to the server). */
  newOps: WireOp[]
  /** Any critical versions detected after the merge. */
  criticalVersionsDetected: { agentId: string; seq: number; snapshot: string }[]
}

/**
 * Integrate incoming WireOps into the server's authoritative document.
 *
 * Steps:
 * 1. For each op: call pushRemoteOp (deduplicates, enforces seq order).
 * 2. Update the server branch snapshot with checkoutFancy.
 * 3. Detect any new critical versions.
 * 4. Persist new ops to PostgreSQL (batch insert, idempotent).
 * 5. Return the truly new ops (for broadcasting to other clients).
 */
export async function applyRemoteOps(
  db: DB,
  session: SessionState,
  wireOps: WireOp[],
  persist: boolean = true,
): Promise<MergeResult> {
  const { doc } = session
  const newOps: WireOp[] = []
  
  // Maintain a buffer on the session if it doesn't exist
  if (!session.outOfOrderBuffer) {
    session.outOfOrderBuffer = new Map()
  }
  const buffer = session.outOfOrderBuffer

  // Queue incoming ops for processing
  const toProcess = [...wireOps]
  const now = Date.now()

  // Clean up old buffered ops (memory leak prevention)
  for (const [key, item] of buffer) {
    if (now - item.addedAt > 60000) { // 60 seconds TTL
      buffer.delete(key)
    }
  }

  while (toProcess.length > 0) {
    const wire = toProcess.shift()!
    try {
      const lv = pushRemoteOp(doc.oplog, wireOpToRemoteOp(wire))
      if (lv !== -1) {
        newOps.push(wire)
        
        // A new op was successfully integrated! 
        if (buffer.size > 0) {
          toProcess.push(...Array.from(buffer.values()).map(v => v.op))
          buffer.clear()
        }
      }
    } catch (err) {
      // Out-of-order delivery: the parent isn't here yet.
      const key = `${wire.agentId}:${wire.seq}`
      if (!buffer.has(key)) {
        buffer.set(key, { op: wire, addedAt: now })
        console.log(`[merge] Buffered out-of-order op [${key}]`)
      }
    }
  }

  if (newOps.length === 0) return { newOps: [], criticalVersionsDetected: [] }

  // Update the server's materialised snapshot.
  checkoutFancy(doc.oplog, doc.branch)

  // Detect critical versions.
  const criticalVersionsDetected: MergeResult['criticalVersionsDetected'] = []
  const frontier = doc.oplog.frontier

  if (frontier.length === 1) {
    const lv = frontier[0]
    const cv = detectCriticalVersion(doc.oplog, lv, frontier, doc.getText())
    if (cv) {
      criticalVersionsDetected.push({
        agentId: cv.id[0],
        seq: cv.id[1],
        snapshot: cv.snapshot,
      })
    }
  }

  // Persist to DB if requested (fire-and-forget; don't block the merge).
  if (persist) {
    persistAsync(db, session.docId, newOps, criticalVersionsDetected)
  }

  return { newOps, criticalVersionsDetected }
}

async function persistAsync(
  db: DB,
  docId: string,
  ops: WireOp[],
  cvs: { agentId: string; seq: number; snapshot: string }[],
): Promise<void> {
  try {
    await insertOps(db, docId, ops)
    for (const cv of cvs) {
      await upsertCriticalVersion(db, docId, cv.agentId, cv.seq, cv.snapshot)
    }
  } catch (err) {
    console.error('[merge] DB persist failed:', err)
  }
}

// ─── Catch-up computation ─────────────────────────────────────────────────────

/**
 * Get all ops that the connecting client doesn't have.
 * Used when a client reconnects after being offline.
 */
export async function getCatchupOps(
  db: DB,
  docId: string,
  theirVersions: VersionMap,
): Promise<WireOp[]> {
  return getMissingOps(db, docId, theirVersions)
}
