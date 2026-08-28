/**
 * Critical version detection and management.
 *
 * A critical version is a point in the DAG where the graph narrows to a
 * single linear point — every op before it is a causal ancestor of every op
 * after it. At a critical version the expensive CRDTItem state accumulated
 * from all prior ops can safely be discarded and replaced with placeholders.
 *
 * This module maintains a global set of known critical LVs (in-memory).
 * The server also persists them to PostgreSQL for cold-start acceleration.
 */

import type { CriticalVersion, LV, OpLog } from './types.js'

// ─── In-memory registry ────────────────────────────────────────────────────

/** Set of LVs that have been confirmed as critical versions. */
const criticalLVs = new Set<LV>()

/** Full CriticalVersion records (LV + Id + snapshot). */
const criticalVersions: CriticalVersion[] = []

export function isCriticalVersion(lv: LV): boolean {
  return criticalLVs.has(lv)
}

export function getCriticalVersions(): CriticalVersion[] {
  return criticalVersions.slice()
}

/** Load pre-computed critical versions from the server (on client startup). */
export function loadCriticalVersions(cvs: CriticalVersion[]): void {
  for (const cv of cvs) {
    if (!criticalLVs.has(cv.lv)) {
      criticalLVs.add(cv.lv)
      criticalVersions.push(cv)
    }
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Check whether `lv` is a critical version, given the oplog state
 * immediately after `lv` was applied.
 *
 * An LV is critical iff:
 * 1. The oplog frontier after applying it is exactly [lv] (single head).
 * 2. The op at `lv` has exactly one parent (or no parents = ROOT successor).
 * 3. That parent is also a critical version (or is ROOT, i.e. parents=[]).
 *
 * Condition 3 ensures we only mark strict linear chains, not just any
 * point where the frontier happens to be size-1.
 */
export function detectCriticalVersion(
  oplog: OpLog,
  lv: LV,
  currentFrontier: LV[],
  snapshotAtLV: string,
): CriticalVersion | null {
  if (criticalLVs.has(lv)) return null // Already known.

  const op = oplog.ops[lv]

  // Condition 1: frontier is a single head (this op).
  if (currentFrontier.length !== 1 || currentFrontier[0] !== lv) return null

  // Condition 2: single parent (or root).
  if (op.parents.length > 1) return null

  // Condition 3: parent is critical (or op is the first ever).
  const parentIsCritical =
    op.parents.length === 0 || criticalLVs.has(op.parents[0])

  if (!parentIsCritical) return null

  const cv: CriticalVersion = {
    lv,
    id: op.id,
    snapshot: snapshotAtLV,
  }

  criticalLVs.add(lv)
  criticalVersions.push(cv)
  return cv
}

/**
 * Scan all ops in the oplog (in order) and detect all critical versions,
 * recording their snapshots. Used on server startup when loading from DB
 * without pre-computed critical versions.
 */
export function detectAllCriticalVersions(
  oplog: OpLog,
  snapshots: Map<LV, string>,
): CriticalVersion[] {
  const detected: CriticalVersion[] = []
  let frontier: LV[] = []

  for (let lv = 0; lv < oplog.ops.length; lv++) {
    const op = oplog.ops[lv]
    // Simulate frontier advancement.
    frontier = frontier.filter(f => !op.parents.includes(f))
    frontier.push(lv)

    const snapshot = snapshots.get(lv) ?? ''
    const cv = detectCriticalVersion(oplog, lv, frontier, snapshot)
    if (cv) detected.push(cv)
  }

  return detected
}

/**
 * Get the most recent critical version whose LV is <= the given LV.
 * Used by the server to find the nearest checkpoint for cold-start.
 */
export function getNearestCriticalVersion(beforeLV: LV): CriticalVersion | null {
  let best: CriticalVersion | null = null
  for (const cv of criticalVersions) {
    if (cv.lv <= beforeLV) {
      if (best === null || cv.lv > best.lv) best = cv
    }
  }
  return best
}

/** Reset all state (used in tests). */
export function resetCriticalVersions(): void {
  criticalLVs.clear()
  criticalVersions.length = 0
}
