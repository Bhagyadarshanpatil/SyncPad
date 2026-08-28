/**
 * DAG diff and traversal planning.
 *
 * The key operation here is: given two frontiers A and B in the same DAG,
 * find which LVs are in A-only, B-only, or shared.
 * This powers the retreat/advance walk in checkout.
 */

import type { LV, OpLog } from './types.js'

// ─── Simple diff ─────────────────────────────────────────────────────────────

export interface DiffResult {
  /** LVs reachable from A but not B (need to be retreated). */
  aOnly: LV[]
  /** LVs reachable from B but not A (need to be advanced). */
  bOnly: LV[]
}

const enum DiffFlag { A, B, Shared }

/**
 * Compute the symmetric difference between two DAG frontiers.
 * Uses a max-priority queue (highest LV first) so we process
 * descendants before ancestors, stopping as soon as we reach shared nodes.
 */
export function diff(oplog: OpLog, a: LV[], b: LV[]): DiffResult {
  const flags = new Map<LV, DiffFlag>()
  let numShared = 0

  // Simple max-heap using sorted insertion (fine for small frontiers).
  const queue: LV[] = []

  function enq(v: LV, flag: DiffFlag) {
    const oldFlag = flags.get(v)
    if (oldFlag == null) {
      flags.set(v, flag)
      if (flag === DiffFlag.Shared) numShared++
      // Insert in descending order.
      let i = queue.length
      while (i > 0 && queue[i - 1] < v) i--
      queue.splice(i, 0, v)
    } else if (flag !== oldFlag && oldFlag !== DiffFlag.Shared) {
      flags.set(v, DiffFlag.Shared)
      numShared++
    }
  }

  for (const lv of a) enq(lv, DiffFlag.A)
  for (const lv of b) enq(lv, DiffFlag.B)

  const aOnly: LV[] = []
  const bOnly: LV[] = []

  while (queue.length > numShared) {
    const lv = queue.shift()!
    const flag = flags.get(lv)!

    if (flag === DiffFlag.Shared) {
      numShared--
    } else if (flag === DiffFlag.A) {
      aOnly.push(lv)
    } else {
      bOnly.push(lv)
    }

    for (const p of oplog.ops[lv].parents) {
      enq(p, flag)
    }
  }

  return { aOnly, bOnly: bOnly.reverse() }
}

// ─── Ops-to-visit planning ────────────────────────────────────────────────────

export interface OpsToVisit {
  /** The common ancestor version of A and B. */
  commonVersion: LV[]
  /**
   * Ops in A's history (shared with B) that we need to replay
   * to set up CRDT state — but without modifying the snapshot.
   */
  sharedOps: LV[]
  /**
   * Ops only in B's history — these are the genuinely new ops
   * that we apply to the snapshot to produce the merged result.
   */
  bOnlyOps: LV[]
}

function compareArrays(a: LV[], b: LV[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const d = a[i] - b[i]
    if (d !== 0) return d
  }
  return 0
}

type MergePoint = { v: LV[]; isInA: boolean }

/**
 * Plan the minimal set of operations to walk in order to merge
 * frontier B into a branch currently at frontier A.
 *
 * This is the core of checkoutFancy — it avoids re-walking ops
 * that both A and B already share.
 */
export function findOpsToVisit(oplog: OpLog, a: LV[], b: LV[]): OpsToVisit {
  // Special case: if A is the empty frontier (fresh / empty branch), every op
  // reachable from B is a genuinely new op — no shared ancestry to compute.
  if (a.length === 0) {
    const bOnlyOps: LV[] = []
    const visited = new Set<LV>()
    const stack = [...b]
    while (stack.length > 0) {
      const lv = stack.pop()!
      if (visited.has(lv)) continue
      visited.add(lv)
      bOnlyOps.push(lv)
      for (const p of oplog.ops[lv].parents) {
        if (!visited.has(p)) stack.push(p)
      }
    }
    bOnlyOps.sort((x, y) => x - y) // ascending — apply oldest first
    return { commonVersion: [], sharedOps: [], bOnlyOps }
  }

  // Priority queue: process highest LV arrays first (descending).
  const queue: MergePoint[] = []

  function enq(v: LV[], isInA: boolean) {
    if (v.length === 0) return  // Empty frontier — nothing to enqueue.
    const mp: MergePoint = { v: v.slice().sort((x, y) => y - x), isInA }
    // Insert in order: highest v first.
    let i = queue.length
    while (i > 0 && compareArrays(queue[i - 1].v, mp.v) < 0) i--
    queue.splice(i, 0, mp)
  }

  enq(a, true)
  enq(b, false)

  let commonVersion: LV[] = []
  const sharedOps: LV[] = []
  const bOnlyOps: LV[] = []

  while (queue.length > 0) {
    let { v, isInA } = queue.shift()!

    // Consume all items at the same version.
    while (queue.length > 0 && compareArrays(queue[0].v, v) === 0) {
      const peer = queue.shift()!
      if (peer.isInA) isInA = true
    }

    if (queue.length === 0) {
      // Nothing left — this is the common ancestor.
      commonVersion = v.slice().reverse()
      break
    }

    if (v.length >= 2) {
      // Merge point: break it up into individual LVs.
      for (const vv of v) enq([vv], isInA)
    } else {
      const lv = v[0]
      if (isInA) sharedOps.push(lv)
      else bOnlyOps.push(lv)
      enq(oplog.ops[lv].parents, isInA)
    }
  }

  return {
    commonVersion,
    sharedOps: sharedOps.reverse(),
    bOnlyOps: bOnlyOps.reverse(),
  }
}
