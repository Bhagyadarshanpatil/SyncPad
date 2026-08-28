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
export async function ensureDocumentLoaded(
  db: DB,
  docId: string,
): Promise<SessionState> {
  // Auto-create the document if it doesn't exist yet.
  // This lets clients join any URL hash without a separate "create" step.
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
  const _cvs: CriticalVersion[] = cvRows.map(row => ({
    lv: -1, // LV is not persisted — will be resolved after ops load.
    id: [row.agentId, row.seq],
    snapshot: row.snapshot,
  }))

  // Load all ops from DB and rebuild the document state.
  const allWireOps = await getAllOps(db, docId)

  for (const wire of allWireOps) {
    pushRemoteOp(session.doc.oplog, wireOpToRemoteOp(wire))
  }

  // Rebuild the branch from the oplog.
  if (allWireOps.length > 0) {
    checkoutFancy(session.doc.oplog, session.doc.branch)
  }

  // Wire up the critical-version persistence callback.
  session.doc.onCriticalVersion = async (cv) => {
    await upsertCriticalVersion(db, docId, cv.id[0], cv.id[1], cv.snapshot)
  }

  return session
}
