/**
 * Critical version detection and management.
 *
 * A critical version is a point in the DAG where the graph narrows to a
 * single linear point — every op before it is a causal ancestor of every op
 * after it. At a critical version the expensive CRDTItem state accumulated
 * from all prior ops can safely be discarded and replaced with placeholders.
 */

import type { CriticalVersion, LV, OpLog } from './types.js'

function initCVState(oplog: OpLog) {
  if (!oplog.criticalLVs) oplog.criticalLVs = new Set<LV>()
  if (!oplog.criticalVersions) oplog.criticalVersions = []
}

export function isCriticalVersion(oplog: OpLog, lv: LV): boolean {
  if (!oplog.criticalLVs) return false
  return oplog.criticalLVs.has(lv)
}

export function getCriticalVersions(oplog: OpLog): CriticalVersion[] {
  if (!oplog.criticalVersions) return []
  return oplog.criticalVersions.slice()
}

/** Load pre-computed critical versions from the server (on client startup). */
export function loadCriticalVersions(oplog: OpLog, cvs: CriticalVersion[]): void {
  initCVState(oplog)
  for (const cv of cvs) {
    if (!oplog.criticalLVs!.has(cv.lv)) {
      oplog.criticalLVs!.add(cv.lv)
      oplog.criticalVersions!.push(cv)
    }
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

export function detectCriticalVersion(
  oplog: OpLog,
  lv: LV,
  currentFrontier: LV[],
  snapshotAtLV: string,
): CriticalVersion | null {
  initCVState(oplog)
  if (oplog.criticalLVs!.has(lv)) return null // Already known.

  const op = oplog.ops[lv]

  // Condition 1: frontier is a single head (this op).
  if (currentFrontier.length !== 1 || currentFrontier[0] !== lv) return null

  // Condition 2: single parent (or root).
  if (op.parents.length > 1) return null

  // Condition 3: parent is critical (or op is the first ever).
  const parentIsCritical =
    op.parents.length === 0 || oplog.criticalLVs!.has(op.parents[0])

  if (!parentIsCritical) return null

  const cv: CriticalVersion = {
    lv,
    id: op.id,
    snapshot: snapshotAtLV,
  }

  oplog.criticalLVs!.add(lv)
  oplog.criticalVersions!.push(cv)
  return cv
}

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

export function getNearestCriticalVersion(oplog: OpLog, beforeLV: LV): CriticalVersion | null {
  if (!oplog.criticalVersions) return null
  let best: CriticalVersion | null = null
  for (const cv of oplog.criticalVersions) {
    if (cv.lv <= beforeLV) {
      if (best === null || cv.lv > best.lv) best = cv
    }
  }
  return best
}

/** Reset all state (used in tests). */
export function resetCriticalVersions(oplog: OpLog): void {
  if (oplog.criticalLVs) oplog.criticalLVs.clear()
  if (oplog.criticalVersions) oplog.criticalVersions.length = 0
}
