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
): Promise<MergeResult> {
  const { doc } = session
  const newOps: WireOp[] = []

  for (const wire of wireOps) {
    try {
      const lv = pushRemoteOp(doc.oplog, wireOpToRemoteOp(wire))
      if (lv !== -1) {
        // lv === -1 means it was already known (duplicate), skip.
        newOps.push(wire)
      }
    } catch (err) {
      // Out-of-order delivery: the parent isn't here yet.
      // In production, buffer and retry. For now, log and skip.
      console.warn(`[merge] Could not apply op [${wire.agentId}:${wire.seq}]:`, (err as Error).message)
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

  // Persist to DB (fire-and-forget; don't block the merge).
  persistAsync(db, session.docId, newOps, criticalVersionsDetected)

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
