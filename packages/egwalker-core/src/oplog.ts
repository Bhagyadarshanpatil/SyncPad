/**
 * OpLog management: creating, merging, and advancing the causal DAG.
 */

import type { Id, LV, Op, OpLog, VersionMap, WireOp } from './types.js'

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createOpLog(): OpLog {
  return { ops: [], frontier: [], version: {} }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const idEq = (a: Id, b: Id): boolean =>
  a === b || (a[0] === b[0] && a[1] === b[1])

/** Sort LVs descending (highest first) — used by priority queues. */
export const sortLVsDesc = (lvs: LV[]): LV[] => lvs.slice().sort((a, b) => b - a)

/** Sort LVs ascending. */
export const sortLVs = (lvs: LV[]): LV[] => lvs.slice().sort((a, b) => a - b)

/**
 * Translate a portable Id to a local LV within this oplog.
 * Throws if not found — callers must ensure parents arrive before children.
 */
export function idToLV(oplog: OpLog, id: Id): LV {
  // Linear scan is fine for now; a Map<agentId, Map<seq,LV>> can optimise later.
  for (let i = oplog.ops.length - 1; i >= 0; i--) {
    if (idEq(oplog.ops[i].id, id)) return i
  }
  throw new Error(`Op not found: [${id[0]}, ${id[1]}]`)
}

/**
 * Advance the frontier by adding newLV and removing any of its parents.
 * The frontier always contains exactly the "heads" of the DAG (ops with no children yet).
 */
export function advanceFrontier(frontier: LV[], newLV: LV, parents: LV[]): LV[] {
  const next = frontier.filter(v => !parents.includes(v))
  next.push(newLV)
  return sortLVs(next)
}

// ─── Local op push ────────────────────────────────────────────────────────────

/**
 * Record a locally generated op (insert or delete).
 * The parents are always the current frontier — this op "knows about" everything
 * the local agent has seen so far.
 */
type LocalOpData =
  | { type: 'ins'; pos: number; content: string }
  | { type: 'del'; pos: number }

function pushLocalOp(
  oplog: OpLog,
  agentId: string,
  opData: LocalOpData,
): LV {
  const seq = (oplog.version[agentId] ?? -1) + 1
  const lv = oplog.ops.length
  const id: Id = [agentId, seq]
  const parents = oplog.frontier.slice()

  let op: Op
  if (opData.type === 'ins') {
    op = { type: 'ins', id, parents, pos: opData.pos, content: opData.content }
  } else {
    op = { type: 'del', id, parents, pos: opData.pos }
  }

  oplog.ops.push(op)
  oplog.frontier = [lv]
  oplog.version[agentId] = seq
  return lv
}

export function localInsert(
  oplog: OpLog,
  agentId: string,
  pos: number,
  content: string,
): LV[] {
  const lvs: LV[] = []
  // Each character gets its own op, position increments as we go.
  for (const ch of [...content]) {
    lvs.push(pushLocalOp(oplog, agentId, { type: 'ins', pos, content: ch }))
    pos++
  }
  return lvs
}

export function localDelete(
  oplog: OpLog,
  agentId: string,
  pos: number,
  delLen: number,
): LV[] {
  const lvs: LV[] = []
  for (let i = 0; i < delLen; i++) {
    lvs.push(pushLocalOp(oplog, agentId, { type: 'del', pos }))
  }
  return lvs
}

// ─── Remote op push ───────────────────────────────────────────────────────────

/**
 * Integrate a remote op that was received from another peer or loaded from DB.
 * parentIds are the PORTABLE parent Ids (not LVs) as sent over the wire.
 * Returns the new LV, or -1 if the op was already known.
 */
export type RemoteOpData =
  | { type: 'ins'; id: Id; parentIds: [string, number][]; pos: number; content: string }
  | { type: 'del'; id: Id; parentIds: [string, number][]; pos: number }

export function pushRemoteOp(
  oplog: OpLog,
  op: RemoteOpData,
): LV {
  const [agentId, seq] = op.id
  const lastKnownSeq = oplog.version[agentId] ?? -1

  if (lastKnownSeq >= seq) return -1 // Already have it.

  if (seq !== lastKnownSeq + 1) {
    throw new Error(
      `Out-of-order op from ${agentId}: expected seq ${lastKnownSeq + 1}, got ${seq}`,
    )
  }

  const lv = oplog.ops.length
  const parents = sortLVs(op.parentIds.map(pid => idToLV(oplog, pid as Id)))

  // Reconstruct the full Op with local LVs for parents.
  let fullOp: Op
  if (op.type === 'ins') {
    fullOp = { type: 'ins', id: op.id, parents, pos: op.pos, content: op.content }
  } else {
    fullOp = { type: 'del', id: op.id, parents, pos: op.pos }
  }
  oplog.ops.push(fullOp)
  oplog.frontier = advanceFrontier(oplog.frontier, lv, parents)
  oplog.version[agentId] = seq

  return lv
}

// ─── Merge two oplogs ─────────────────────────────────────────────────────────

/**
 * Merge all ops from `src` into `dest`.
 * Translates portable Ids correctly across the two oplogs.
 * Idempotent — ops already in `dest` are skipped.
 */
export function mergeInto(dest: OpLog, src: OpLog): void {
  for (const op of src.ops) {
    const parentIds = op.parents.map(lv => src.ops[lv].id as [string, number])
    const remoteOp: RemoteOpData = op.type === 'ins'
      ? { type: 'ins', id: op.id, parentIds, pos: op.pos, content: op.content }
      : { type: 'del', id: op.id, parentIds, pos: op.pos }
    pushRemoteOp(dest, remoteOp)
  }
}

// ─── WireOp ↔ Op conversion ───────────────────────────────────────────────────

/** Convert a WireOp (from the network) into the format pushRemoteOp expects. */
export function wireOpToRemoteOp(
  wire: WireOp,
): RemoteOpData {
  const id: Id = [wire.agentId, wire.seq]
  if (wire.type === 'ins') {
    return { type: 'ins', id, parentIds: wire.parentIds, pos: wire.pos, content: wire.content! }
  }
  return { type: 'del', id, parentIds: wire.parentIds, pos: wire.pos }
}

/** Convert an Op from the oplog (with local LVs) into a portable WireOp. */
export function opToWireOp(oplog: OpLog, lv: LV): WireOp {
  const op = oplog.ops[lv]
  const wire: WireOp = {
    agentId: op.id[0],
    seq: op.id[1],
    type: op.type,
    pos: op.pos,
    parentIds: op.parents.map(p => oplog.ops[p].id as [string, number]),
  }
  if (op.type === 'ins') wire.content = op.content
  return wire
}

/** Export all ops in an oplog as WireOps (for sending over the network). */
export function oplogToWireOps(oplog: OpLog): WireOp[] {
  return oplog.ops.map((_, lv) => opToWireOp(oplog, lv))
}

/** Build the `knownVersions` map from an oplog (for the 'join' handshake). */
export function getVersionMap(oplog: OpLog): VersionMap {
  return { ...oplog.version }
}

/**
 * Returns only the ops that the remote peer (identified by their knownVersions)
 * does not yet have. Used to compute catch-up payloads.
 */
export function getMissingOps(oplog: OpLog, theirVersions: VersionMap): WireOp[] {
  const result: WireOp[] = []
  for (let lv = 0; lv < oplog.ops.length; lv++) {
    const op = oplog.ops[lv]
    const theirSeq = theirVersions[op.id[0]] ?? -1
    if (op.id[1] > theirSeq) {
      result.push(opToWireOp(oplog, lv))
    }
  }
  return result
}
