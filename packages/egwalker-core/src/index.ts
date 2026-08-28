/**
 * Public API barrel for egwalker-core.
 * Import everything you need from '@syncpad/egwalker-core'.
 */

// Types
export type {
  Id, LV, Op, InsOp, DelOp, OpLog, OpType,
  Branch, CRDTDoc, CRDTItem, DocItem, PlaceholderItem,
  CriticalVersion, VersionMap,
  WireOp, ClientMessage, ServerMessage, PeerInfo,
  UndoState, UndoResult,
} from './types.js'

export { NOT_YET_INSERTED, INSERTED } from './types.js'

// OpLog management
export {
  createOpLog,
  localInsert, localDelete,
  pushRemoteOp, mergeInto,
  wireOpToRemoteOp, opToWireOp, oplogToWireOps,
  getVersionMap, getMissingOps,
  idToLV, advanceFrontier,
} from './oplog.js'

// DAG diff
export { diff, findOpsToVisit } from './diff.js'
export type { DiffResult, OpsToVisit } from './diff.js'

// CRDT integration
export { integrate, apply, advance, retreat, findByCurrentPos, isPlaceholder } from './integrate.js'

// Checkout
export { checkout, checkoutFancy, do1Operation, createBranch } from './checkout.js'

// Critical versions
export {
  isCriticalVersion, getCriticalVersions, loadCriticalVersions,
  detectCriticalVersion, detectAllCriticalVersions,
  getNearestCriticalVersion, resetCriticalVersions,
} from './criticalVersion.js'

// Undo / Redo
export { createUndoState, pushToUndoStack, undo, redo } from './undo.js'

// Columnar encoder
export { encodeOpLog, encodeWireOps, decodeOpLog, topoSort } from './columnarEncoder.js'
export type { EncodedOpLog } from './columnarEncoder.js'

// ─── High-level CRDTDocument class ───────────────────────────────────────────
// Convenience wrapper used by both client and server.

import { createOpLog, localInsert, localDelete, mergeInto, oplogToWireOps, getMissingOps } from './oplog.js'
import { checkoutFancy, createBranch, checkout } from './checkout.js'
import { createUndoState, pushToUndoStack } from './undo.js'
import { detectCriticalVersion } from './criticalVersion.js'
import type { Branch, OpLog, UndoState, WireOp, VersionMap, CriticalVersion } from './types.js'
import { pushRemoteOp, wireOpToRemoteOp } from './oplog.js'

export class CRDTDocument {
  oplog: OpLog
  branch: Branch
  undoState: UndoState
  agentId: string

  /** Fires when a critical version is detected (so callers can persist it). */
  onCriticalVersion?: (cv: CriticalVersion) => void

  constructor(agentId: string) {
    this.agentId = agentId
    this.oplog = createOpLog()
    this.branch = createBranch()
    this.undoState = createUndoState()
  }

  /** Insert text at a visible character position. */
  insert(pos: number, text: string): WireOp[] {
    const lvs = localInsert(this.oplog, this.agentId, pos, text)
    this.branch.snapshot.splice(pos, 0, ...[...text])
    this.branch.frontier = this.oplog.frontier.slice()
    pushToUndoStack(this.undoState, lvs)
    this._checkCritical()
    return lvs.map(lv => this._toWire(lv))
  }

  /** Delete `count` visible characters starting at position `pos`. */
  delete(pos: number, count: number): WireOp[] {
    const lvs = localDelete(this.oplog, this.agentId, pos, count)
    this.branch.snapshot.splice(pos, count)
    this.branch.frontier = this.oplog.frontier.slice()
    pushToUndoStack(this.undoState, lvs)
    this._checkCritical()
    return lvs.map(lv => this._toWire(lv))
  }

  /** Apply incoming remote WireOps and update the branch. */
  applyRemote(wireOps: WireOp[]): void {
    for (const wire of wireOps) {
      pushRemoteOp(this.oplog, wireOpToRemoteOp(wire))
    }
    checkoutFancy(this.oplog, this.branch)
    this._checkCritical()
  }

  /** Get ops the remote peer doesn't have yet (for catch-up). */
  getMissingFor(theirVersions: VersionMap): WireOp[] {
    return getMissingOps(this.oplog, theirVersions)
  }

  /** Current document as a string. */
  getText(): string {
    return this.branch.snapshot.join('')
  }

  /** Verify snapshot matches a full checkout (debug only). */
  verify(): boolean {
    const full = checkout(this.oplog).join('')
    return full === this.getText()
  }

  private _toWire(lv: number): WireOp {
    const op = this.oplog.ops[lv]
    const wire: WireOp = {
      agentId: op.id[0],
      seq: op.id[1],
      type: op.type,
      pos: op.pos,
      parentIds: op.parents.map(p => this.oplog.ops[p].id as [string, number]),
    }
    if (op.type === 'ins') wire.content = op.content
    return wire
  }

  private _checkCritical(): void {
    if (!this.onCriticalVersion) return
    const frontier = this.oplog.frontier
    if (frontier.length === 1) {
      const lv = frontier[0]
      const cv = detectCriticalVersion(this.oplog, lv, frontier, this.getText())
      if (cv) this.onCriticalVersion(cv)
    }
  }
}
