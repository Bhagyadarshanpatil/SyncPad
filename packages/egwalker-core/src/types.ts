/**
 * Core type definitions for the Eg-walker collaborative editing algorithm.
 *
 * Key concepts:
 * - Id: A globally portable identifier for an op — [agentId, seq].
 *   Never changes across peers. Safe to persist and transmit.
 * - LV (Local Version): An integer index into oplog.ops[].
 *   Only valid within a single peer's memory — do NOT persist or transmit raw LVs.
 * - The DAG is stored as a flat array (oplog.ops[]) where each entry's
 *   index IS its LV, and parent references are stored as LVs.
 */

// ─── Identifiers ────────────────────────────────────────────────────────────

/** Globally unique, portable op identifier. [agentId, seq]. */
export type Id = [agent: string, seq: number]

/** Local Version: index into oplog.ops[]. Only valid within one peer. */
export type LV = number

/** Portable version map: last known seq per agent. */
export type VersionMap = Record<string, number>

// ─── Operations ─────────────────────────────────────────────────────────────

export type OpType = 'ins' | 'del'

interface OpBase {
  id: Id
  /** Parent LVs — the frontier at the time this op was created. */
  parents: LV[]
}

export interface InsOp extends OpBase {
  type: 'ins'
  /** Document position (in visible chars) at time of creation. */
  pos: number
  content: string
}

export interface DelOp extends OpBase {
  type: 'del'
  /** Document position (in visible chars) at time of creation. */
  pos: number
}

export type Op = InsOp | DelOp

// ─── OpLog (the DAG) ─────────────────────────────────────────────────────────

export interface OpLog {
  /** Flat array of all operations. LV = index in this array. */
  ops: Op[]
  /**
   * Current frontier: LVs with no children yet.
   * This is the "head" of the DAG — what new ops will list as their parents.
   */
  frontier: LV[]
  /** Highest seq seen per agent — used for dedup and ordering. */
  version: VersionMap
}

// ─── CRDT document state ─────────────────────────────────────────────────────

export const NOT_YET_INSERTED = -1
export const INSERTED = 0
// curState > 0  means deleted (reference-counted: deleted by N ops)

/**
 * A slot in the integrated document list.
 * Each inserted character gets one CRDTItem that lives forever
 * (even if deleted — it just becomes a tombstone).
 */
export interface CRDTItem {
  /** LV of the ins op that created this item. */
  lv: LV
  /** LV of the item immediately to the left when this was inserted, or -1. */
  originLeft: LV | -1
  /** LV of the first non-NYI item to the right when inserted, or -1. */
  originRight: LV | -1
  /** Whether this item has been permanently deleted (tombstone). */
  deleted: boolean
  /**
   * State machine:
   *  NOT_YET_INSERTED (-1): not yet applied in the current walk
   *  INSERTED (0):          currently visible / logically present
   *  > 0:                   deleted by that many concurrent delete ops
   */
  curState: number
}

/**
 * A placeholder item representing an opaque range of document content
 * at a critical version. Replaces all CRDTItems up to that point,
 * allowing O(1) fast-path for sequential edits past a critical version.
 */
export interface PlaceholderItem {
  readonly isPlaceholder: true
  /** Synthetic LV — a large constant so it never collides with real LVs. */
  lv: LV
  /** The range [startPos, endPos) of visible characters this covers. */
  startPos: number
  endPos: number
  curState: number // always INSERTED for placeholders (unless deleted)
  deleted: boolean
  originLeft: -1
  originRight: -1
}

export type DocItem = CRDTItem | PlaceholderItem

/** Internal CRDT traversal state used during checkout / merge walks. */
export interface CRDTDoc {
  items: DocItem[]
  currentVersion: LV[]
  /** Maps del-op LV → the LV of the item it deleted. */
  delTargets: LV[]
  /** Fast lookup: LV → CRDTItem (index array, sparse). */
  itemsByLV: CRDTItem[]
  /** Fast lookup for placeholders (only used in checkoutFancy). */
  placeholders?: Map<LV, PlaceholderItem>
}

// ─── Branch (materialised snapshot) ──────────────────────────────────────────

/**
 * A materialised view of the document at a particular version.
 * The snapshot is a char array so splicing is O(n) but simpler than a rope.
 * (A rope/B-tree optimisation can come later.)
 */
export interface Branch {
  /** The visible document content, one entry per character. */
  snapshot: string[]
  /** The version this snapshot corresponds to (LVs). */
  frontier: LV[]
}

// ─── Critical versions ────────────────────────────────────────────────────────

/**
 * A critical version is an LV where the DAG narrows to a single linear point.
 * All ops before it are ancestors of all ops after it.
 * At a critical version we can safely discard all prior CRDT state.
 */
export interface CriticalVersion {
  /** The LV that is the critical point. */
  lv: LV
  /** The portable Id of that op. */
  id: Id
  /** The full document snapshot at this point (for fast server cold-start). */
  snapshot: string
}

// ─── Wire protocol types ──────────────────────────────────────────────────────

/**
 * Portable op representation for transmission.
 * Uses portable Ids (never raw LVs) for parent references.
 */
export interface WireOp {
  agentId: string
  seq: number
  type: OpType
  pos: number
  content?: string
  /** Portable parent refs: [[agentId, seq], ...] */
  parentIds: [string, number][]
}

/** Client → Server messages */
export type ClientMessage =
  | {
      type: 'join'
      docId: string
      agentId: string
      knownVersions: Record<string, number>
      token?: string // Google ID token for auth
    }
  | { type: 'ops'; docId: string; ops: WireOp[] }
  | { type: 'catchup'; docId: string; ops?: WireOp[]; encoding?: 'binary'; payload?: string }
  | { type: 'ping'; docId: string; cursor: number; name: string; picture?: string }

export type ServerMessage =
  | { type: 'peers'; docId: string; peers: PeerInfo[] }
  | { type: 'ops'; docId: string; fromAgent: string; ops: WireOp[] }
  | { type: 'catchup'; docId: string; ops?: WireOp[]; encoding?: 'binary'; payload?: string }
  | { type: 'ack'; docId: string; opIds: [string, number][] }
  | { type: 'cursor'; docId: string; agentId: string; cursor: number; name: string; picture?: string }
  | { type: 'error'; message: string }

export interface PeerInfo {
  agentId: string // The CRDT replicaId (unique per tab)
  userId?: string // Google User ID
  name: string
  picture?: string
  color: string
  cursor?: number
}

// ─── Undo types (re-exported here so index.ts can forward them) ───────────────

export interface UndoState {
  undoStack: LV[]
  redoStack: LV[]
}

export interface UndoResult {
  inverseLVs: LV[]
  snapshotDelta:
    | { type: 'del'; pos: number }
    | { type: 'ins'; pos: number; content: string }
    | null
}
