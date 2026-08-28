/**
 * Agent-scoped undo/redo system.
 *
 * Undo in Eg-walker is NOT a rollback. It generates a new inverse op
 * at the current frontier. This op propagates to all peers like any
 * other operation, so collaborators see the undo happen in real time.
 *
 * The undo stack tracks only the current agent's own LVs — remote
 * ops are never pushed here, preventing cross-agent undo chaos.
 */

import type { Branch, CRDTDoc, LV, OpLog } from './types.js'
import { localDelete, localInsert } from './oplog.js'
import { INSERTED, findByCurrentPos, isPlaceholder } from './integrate.js'

// ─── State ────────────────────────────────────────────────────────────────────

export interface UndoState {
  /** LVs of ops produced by THIS agent, most-recent-first. */
  undoStack: LV[]
  /** LVs of undo ops (inverse ops), for redo. */
  redoStack: LV[]
}

export function createUndoState(): UndoState {
  return { undoStack: [], redoStack: [] }
}

// ─── Stack management ─────────────────────────────────────────────────────────

/** Called after every local insert or delete. */
export function pushToUndoStack(undoState: UndoState, lvs: LV[]): void {
  undoState.undoStack.push(...lvs)
  undoState.redoStack = [] // Any new edit clears the redo stack.
}

// ─── Finding the current visible position of an item ────────────────────────

/**
 * Given the LV of an insert op, find the current visible position
 * of that character in the document (based on the current branch snapshot).
 * Returns -1 if the item has been deleted.
 */
function findVisiblePosOfLV(doc: CRDTDoc, targetLV: LV): number {
  let visiblePos = 0
  for (const item of doc.items) {
    if (isPlaceholder(item)) {
      visiblePos += item.endPos - item.startPos
      continue
    }
    if (item.lv === targetLV) {
      return item.deleted ? -1 : visiblePos
    }
    if (item.curState === INSERTED) visiblePos++
  }
  return -1
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

export interface UndoResult {
  /** The LVs of the inverse op(s) that were generated. */
  inverseLVs: LV[]
  /**
   * How the snapshot changed:
   * For undo of an insert → a deletion occurred (splice out).
   * For undo of a delete  → a reinsertion occurred (splice in).
   */
  snapshotDelta: { type: 'del'; pos: number } | { type: 'ins'; pos: number; content: string } | null
}

/**
 * Undo the most recent local op.
 *
 * Pops from undoStack, generates an inverse op at the current frontier,
 * and returns the new LVs (which the caller must push through the normal
 * local pipeline: IndexedDB → snapshot update → server → broadcast).
 */
export function undo(
  oplog: OpLog,
  branch: Branch,
  doc: CRDTDoc,
  undoState: UndoState,
  agentId: string,
): UndoResult | null {
  if (undoState.undoStack.length === 0) return null

  const targetLV = undoState.undoStack.pop()!
  const targetOp = oplog.ops[targetLV]

  let inverseLVs: LV[]
  let snapshotDelta: UndoResult['snapshotDelta'] = null

  if (targetOp.type === 'ins') {
    // Undo an insert → delete the character.
    const visPos = findVisiblePosOfLV(doc, targetLV)
    if (visPos === -1) {
      // Already deleted by someone else — push anyway as a no-op del.
      inverseLVs = localDelete(oplog, agentId, 0, 0)
    } else {
      inverseLVs = localDelete(oplog, agentId, visPos, 1)
      branch.snapshot.splice(visPos, 1)
      snapshotDelta = { type: 'del', pos: visPos }
    }
  } else {
    // Undo a delete -> re-insert the character.
    // Find the original item directly since delTargets maps delOpLv to dlv.
    const deletedItemLV = doc.delTargets[targetLV]

    if (deletedItemLV == null) {
      // Can't find the deleted item — skip.
      return null
    }

    const deletedItem = doc.itemsByLV[deletedItemLV]
    if (!deletedItem) return null

    // Find where to re-insert: look at the item's originLeft.
    let reinsertPos = 0
    if (deletedItem.originLeft !== -1) {
      reinsertPos = findVisiblePosOfLV(doc, deletedItem.originLeft)
      if (reinsertPos !== -1) reinsertPos++ // insert after originLeft
    }

    const content = (oplog.ops[deletedItemLV] as any).content as string
    inverseLVs = localInsert(oplog, agentId, reinsertPos, content)
    branch.snapshot.splice(reinsertPos, 0, content)
    snapshotDelta = { type: 'ins', pos: reinsertPos, content }
  }

  undoState.redoStack.push(...inverseLVs)
  return { inverseLVs, snapshotDelta }
}

// ─── Redo ─────────────────────────────────────────────────────────────────────

/**
 * Redo the most recently undone op.
 * This generates an inverse-of-inverse op, which effectively re-applies
 * the original change at the current frontier.
 */
export function redo(
  oplog: OpLog,
  branch: Branch,
  doc: CRDTDoc,
  undoState: UndoState,
  agentId: string,
): UndoResult | null {
  if (undoState.redoStack.length === 0) return null

  // Redo is just undoing the undo op.
  const undoOpLV = undoState.redoStack.pop()!
  // Temporarily move it to the undo stack so undo() picks it up.
  undoState.undoStack.push(undoOpLV)

  const result = undo(oplog, branch, doc, undoState, agentId)
  if (!result) return null

  // Move the redo op's inverse back to undoStack.
  undoState.undoStack.push(...result.inverseLVs)
  // Clear the entry we just re-added to redoStack by undo().
  undoState.redoStack.pop()

  return result
}
