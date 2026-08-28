/**
 * Session lifecycle management.
 *
 * Handles:
 * - Creating new documents (assign an ID, persist to DB)
 * - Loading existing documents into memory from the DB
 * - Generating anonymous peer identities (colour + fun pseudonym)
 */

import { v4 as uuid } from 'uuid'

import {
  CRDTDocument,
  loadCriticalVersions,
  pushRemoteOp,
  wireOpToRemoteOp,
  checkoutFancy,
  type CriticalVersion,
} from '@syncpad/egwalker-core'
import type { DB } from '../db/queries.js'
import {
  createDocument,
  getDocument,
  getAllOps,
  getCriticalVersionsForDoc,
  upsertCriticalVersion,
} from '../db/queries.js'
import {
  getOrCreateSession,
  type SessionState,
} from './sessionStore.js'
import { applyRemoteOps } from '../sync/mergeEngine.js'

// ─── Peer identity ────────────────────────────────────────────────────────────



// ─── Document creation ────────────────────────────────────────────────────────

export async function createNewDocument(db: DB, name?: string): Promise<string> {
  const docId = uuid()
  await createDocument(db, docId, name)
  getOrCreateSession(docId) // Pre-warm the in-memory session.
  return docId
}

// ─── Loading a document from DB into memory ───────────────────────────────────

/**
 * Ensure the document is loaded into memory.
 *
 * Strategy (cold-start optimisation):
 * 1. Find the most recent critical version persisted in the DB.
 * 2. Load its snapshot as the branch baseline.
 * 3. Replay only ops AFTER that critical version's (agentId, seq).
 * 4. Run checkoutFancy to get the current branch state.
 *
 * If no critical version exists, load all ops from scratch.
 */
const loadingSessions = new Map<string, Promise<SessionState>>()

export function ensureDocumentLoaded(db: DB, docId: string): Promise<SessionState> {
  if (loadingSessions.has(docId)) {
    return loadingSessions.get(docId)!
  }

  const p = (async () => {
    try {
      // Auto-create the document if it doesn't exist yet.
      let dbDoc = await getDocument(db, docId)
      if (!dbDoc) {
        await createDocument(db, docId)
        dbDoc = await getDocument(db, docId)
      }

      const session = getOrCreateSession(docId)

      // If already loaded (has ops), skip.
      if (session.doc.oplog.ops.length > 0) return session

      // Load persisted critical versions first (populates the in-memory registry).
      const cvRows = await getCriticalVersionsForDoc(db, docId)
      const cvs: CriticalVersion[] = cvRows.map(row => ({
        lv: -1, // LV is not persisted — will be resolved after ops load.
        id: [row.agentId, row.seq],
        snapshot: row.snapshot,
      }))
      
      // Cold-start optimization: load critical versions into the CRDT
      if (cvs.length > 0) {
        loadCriticalVersions(session.doc.oplog, cvs)
      }

      // Load all ops from DB and rebuild the document state.
      // Use applyRemoteOps instead of pushRemoteOp directly to correctly handle
      // any ops that were inserted out-of-order due to database transaction races.
      const allWireOps = await getAllOps(db, docId)
      if (allWireOps.length > 0) {
        await applyRemoteOps(db, session, allWireOps, false)
      }

      // Wire up the critical-version persistence callback.
      session.doc.onCriticalVersion = async (cv) => {
        await upsertCriticalVersion(db, docId, cv.id[0], cv.id[1], cv.snapshot)
      }

      return session
    } finally {
      loadingSessions.delete(docId)
    }
  })()

  loadingSessions.set(docId, p)
  return p
}
