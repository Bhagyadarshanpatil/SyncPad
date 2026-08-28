/**
 * CRDT integration: the core OT-style logic that places a new insertion
 * correctly relative to concurrent insertions from other agents.
 *
 * Also handles retreat/advance for the DAG walk, and deletion application.
 */

import { NOT_YET_INSERTED, INSERTED } from './types.js'
import type { LV, OpLog, CRDTItem, CRDTDoc, DocItem, PlaceholderItem } from './types.js'

export { NOT_YET_INSERTED, INSERTED }

// ─── Doc item helpers ─────────────────────────────────────────────────────────

export function isPlaceholder(item: DocItem): item is PlaceholderItem {
  return 'isPlaceholder' in item && item.isPlaceholder === true
}

// ─── Retreat / Advance ───────────────────────────────────────────────────────

/**
 * Retreat: undo the effect of an op during a DAG walk.
 * For an ins op: mark the item as NOT_YET_INSERTED.
 * For a del op: decrement the curState of the deleted item (un-delete it).
 */
export function retreat(doc: CRDTDoc, oplog: OpLog, opLv: LV): void {
  const op = oplog.ops[opLv]
  const targetLV = op.type === 'ins' ? opLv : doc.delTargets[opLv]
  const item = targetLV >= 1e12 ? doc.placeholders!.get(targetLV)! : doc.itemsByLV[targetLV]
  item.curState--
}

/**
 * Advance: re-apply the effect of an op during a DAG walk.
 * For an ins op: mark the item as INSERTED (or re-applied).
 * For a del op: increment the curState (re-delete it).
 */
export function advance(doc: CRDTDoc, oplog: OpLog, opLv: LV): void {
  const op = oplog.ops[opLv]
  const targetLV = op.type === 'ins' ? opLv : doc.delTargets[opLv]
  const item = targetLV >= 1e12 ? doc.placeholders!.get(targetLV)! : doc.itemsByLV[targetLV]
  item.curState++
}

// ─── Position resolution ──────────────────────────────────────────────────────

/**
 * Find the index in items[] and the corresponding visible-character position
 * for a given target visible position.
 *
 * `targetPos` is the position in the *currently visible* document (curState === INSERTED).
 * Returns { idx: index in items[], endPos: visible char count up to that point }.
 */
export function findByCurrentPos(
  items: DocItem[],
  targetPos: number,
): { idx: number; endPos: number } {
  let curPos = 0   // visible chars counted (curState === INSERTED)
  let endPos = 0   // non-deleted chars counted (for snapshot splicing)
  let idx = 0

  for (; curPos < targetPos; idx++) {
    if (idx >= items.length) throw new Error('Position past end of items list')
    const item = items[idx]
    if (item.curState === INSERTED) curPos++
    if (!item.deleted) endPos++
  }

  return { idx, endPos }
}

function findItemIdxAtLV(items: DocItem[], lv: LV): number {
  const idx = items.findIndex(it => !isPlaceholder(it) && it.lv === lv)
  if (idx < 0) throw new Error(`Item with LV ${lv} not found`)
  return idx
}

// ─── Integrate (OT-style insertion placement) ─────────────────────────────────

/**
 * Find the correct position for `newItem` among concurrent insertions
 * and splice it into `doc.items[]` at that position.
 *
 * This implements the Yjs/YATA integration algorithm used by Eg-walker:
 * - Items with the same originLeft are ordered by their originRight (narrower range first).
 * - Ties are broken by agent ID (lexicographic).
 *
 * If `snapshot` is provided, the character is also spliced into it.
 */
export function integrate(
  doc: CRDTDoc,
  oplog: OpLog,
  newItem: CRDTItem,
  idx: number,
  endPos: number,
  snapshot: string[] | null,
): void {
  let scanIdx = idx
  let scanEndPos = endPos

  const left = scanIdx - 1
  const right =
    newItem.originRight === -1
      ? doc.items.length
      : findItemIdxAtLV(doc.items, newItem.originRight)

  let scanning = false

  while (scanIdx < right) {
    const other = doc.items[scanIdx]

    if (isPlaceholder(other)) {
      // Placeholders are always to the left of real concurrent items.
      break
    }

    if (other.curState !== NOT_YET_INSERTED) break

    const oleft =
      other.originLeft === -1 ? -1 : findItemIdxAtLV(doc.items, other.originLeft)
    const oright =
      other.originRight === -1 ? doc.items.length : findItemIdxAtLV(doc.items, other.originRight)

    const newAgent = oplog.ops[newItem.lv].id[0]
    const otherAgent = oplog.ops[other.lv].id[0]

    if (
      oleft < left ||
      (oleft === left && oright === right && newAgent < otherAgent)
    ) {
      break
    }
    if (oleft === left) scanning = oright < right

    if (!other.deleted) scanEndPos++
    scanIdx++

    if (!scanning) {
      idx = scanIdx
      endPos = scanEndPos
    }
  }

  doc.items.splice(idx, 0, newItem)

  const op = oplog.ops[newItem.lv]
  if (op.type !== 'ins') throw new Error('integrate() called on a del op')
  if (snapshot != null) snapshot.splice(endPos, 0, op.content)
}

// ─── Apply an op to the CRDT doc ─────────────────────────────────────────────

/**
 * Apply a single op (at `opLv`) to `doc`, optionally updating `snapshot`.
 *
 * For an insert: finds the correct position using `findByCurrentPos`, then
 *   calls `integrate()` to place it correctly among concurrent inserts.
 * For a delete: finds the target item and marks it deleted.
 */
export function apply(
  doc: CRDTDoc,
  oplog: OpLog,
  snapshot: string[] | null,
  opLv: LV,
): void {
  const op = oplog.ops[opLv]

  if (op.type === 'del') {
    let { idx, endPos } = findByCurrentPos(doc.items, op.pos)

    // Scan forward past NOT_YET_INSERTED items to find the actual live item.
    while (doc.items[idx].curState !== INSERTED) {
      if (!doc.items[idx].deleted) endPos++
      idx++
    }

    const item = doc.items[idx]
    if (isPlaceholder(item)) {
      // Deleting inside a placeholder — the snapshot handles it.
      if (!item.deleted) {
        // Narrow the placeholder range.
        item.endPos = Math.max(item.startPos, item.endPos - 1)
        if (item.endPos === item.startPos) {
          item.deleted = true
          item.curState = 1
        }
        if (snapshot != null) snapshot.splice(endPos, 1)
      }
      // Store target for retreat/advance — use a synthetic LV.
      doc.delTargets[opLv] = item.lv
      return
    }

    if (!item.deleted) {
      item.deleted = true
      if (snapshot != null) snapshot.splice(endPos, 1)
    }
    item.curState = 1
    doc.delTargets[opLv] = item.lv
  } else {
    // Insert
    const { idx, endPos } = findByCurrentPos(doc.items, op.pos)

    if (idx >= 1) {
      const left = doc.items[idx - 1]
      if (!isPlaceholder(left) && left.curState !== INSERTED) {
        throw new Error('Item to the left is not INSERTED')
      }
    }

    const originLeft = idx === 0 ? -1 : (() => {
      const l = doc.items[idx - 1]
      return isPlaceholder(l) ? -1 : l.lv
    })()

    let originRight: LV = -1
    for (let i = idx; i < doc.items.length; i++) {
      const it = doc.items[i]
      if (isPlaceholder(it)) continue
      if (it.curState !== NOT_YET_INSERTED) {
        originRight = it.lv
        break
      }
    }

    const newItem: CRDTItem = {
      lv: opLv,
      originLeft,
      originRight,
      deleted: false,
      curState: INSERTED,
    }
    doc.itemsByLV[opLv] = newItem

    integrate(doc, oplog, newItem, idx, endPos, snapshot)
  }
}
