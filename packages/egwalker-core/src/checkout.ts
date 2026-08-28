/**
 * Document checkout: materialising the document state from the oplog.
 *
 * Two entry points:
 * - checkout(): full rebuild from scratch (used in tests / verification)
 * - checkoutFancy(): incremental update from a known branch (used at runtime)
 */

import { INSERTED, NOT_YET_INSERTED, advance, apply, retreat } from './integrate.js'
import { diff, findOpsToVisit } from './diff.js'
import type { Branch, CRDTDoc, LV, OpLog, PlaceholderItem } from './types.js'
import { advanceFrontier } from './oplog.js'
import { isCriticalVersion } from './criticalVersion.js'

// ─── Full checkout (from scratch) ─────────────────────────────────────────────

/**
 * Walk the entire oplog from ROOT and produce the final document string.
 * This is O(n²) in general and is only used for correctness verification.
 * Production code always uses `checkoutFancy`.
 */
export function checkout(oplog: OpLog): string[] {
  const doc: CRDTDoc = {
    items: [],
    currentVersion: [],
    delTargets: [],
    itemsByLV: [],
  }
  const snapshot: string[] = []

  for (let lv = 0; lv < oplog.ops.length; lv++) {
    do1Operation(doc, oplog, lv, snapshot)
  }

  return snapshot
}

// ─── Single operation step ────────────────────────────────────────────────────

/**
 * Apply one op to the CRDTDoc, retreating/advancing as needed to get
 * the doc into the correct state for this op's parents.
 */
export function do1Operation(
  doc: CRDTDoc,
  oplog: OpLog,
  lv: LV,
  snapshot: string[] | null,
): void {
  const op = oplog.ops[lv]
  const { aOnly, bOnly } = diff(oplog, doc.currentVersion, op.parents)

  for (const i of aOnly) retreat(doc, oplog, i)
  for (const i of bOnly) advance(doc, oplog, i)

  apply(doc, oplog, snapshot, lv)
  doc.currentVersion = [lv]
}

// ─── Incremental checkout (fancy) ────────────────────────────────────────────

/**
 * Incrementally update `branch` so it reflects `mergeFrontier` (defaults to
 * the oplog's current frontier — i.e., apply all new ops).
 *
 * This is the hot path called after every merge. It only visits ops that
 * are new relative to `branch.frontier`.
 */
export function checkoutFancy(
  oplog: OpLog,
  branch: Branch,
  mergeFrontier: LV[] = oplog.frontier,
): CRDTDoc {
  if (mergeFrontier.length === 0) {
    return {
      items: [],
      currentVersion: [],
      delTargets: [],
      itemsByLV: [],
      placeholders: new Map(),
    }
  }

  const { commonVersion, sharedOps, bOnlyOps } = findOpsToVisit(
    oplog,
    branch.frontier,
    mergeFrontier,
  )

  const doc: CRDTDoc = {
    items: [],
    currentVersion: commonVersion,
    delTargets: [],
    itemsByLV: [],
    placeholders: new Map(),
  }

  // Build a SINGLE placeholder item for all ops in the existing branch snapshot.
  // This turns O(N) object allocation into O(1).
  const placeholderLength = branch.frontier.length > 0
    ? Math.max(...branch.frontier) + 1
    : 0

  if (placeholderLength > 0) {
    const ph: PlaceholderItem = {
      isPlaceholder: true,
      lv: 0 + 1e12, // startPos + 1e12
      startPos: 0,
      endPos: placeholderLength,
      curState: INSERTED,
      deleted: false,
      originLeft: -1,
      originRight: -1,
    }
    doc.items.push(ph)
    doc.placeholders!.set(ph.lv, ph)
  }

  // Phase 1: replay shared ops (adjust CRDT positions, no snapshot mutation).
  for (const lv of sharedOps) {
    do1Operation(doc, oplog, lv, null)
  }

  // Phase 2: apply new ops (bOnly) — these modify the snapshot.
  for (const lv of bOnlyOps) {
    // Fast path: if this op's parent is a critical version AND we're
    // still in a linear (non-divergent) walk, skip retreat/advance.
    const op = oplog.ops[lv]
    const parentIsCritical =
      op.parents.length === 1 && isCriticalVersion(oplog, op.parents[0])

    if (parentIsCritical && doc.currentVersion.length === 1 &&
        doc.currentVersion[0] === op.parents[0]) {
      // Fast path: emit op directly into snapshot without DAG walk.
      apply(doc, oplog, branch.snapshot, lv)
      doc.currentVersion = [lv]
    } else {
      do1Operation(doc, oplog, lv, branch.snapshot)
    }

    branch.frontier = advanceFrontier(branch.frontier, lv, op.parents)
  }

  return doc
}

export function createBranch(): Branch {
  return { snapshot: [], frontier: [] }
}
