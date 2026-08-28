/**
 * Database queries for the SyncPad server.
 * All queries use Drizzle ORM for type safety.
 */

import { eq, and, or, gt, inArray, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'
import type { WireOp, VersionMap } from '@syncpad/egwalker-core'

export type DB = PostgresJsDatabase<typeof schema>

// ─── Documents ────────────────────────────────────────────────────────────────

export async function createDocument(
  db: DB,
  id: string,
  name = 'Untitled',
): Promise<schema.Document> {
  const [doc] = await db
    .insert(schema.documents)
    .values({ id, name })
    .returning()
  return doc
}

export async function getDocument(
  db: DB,
  id: string,
): Promise<schema.Document | undefined> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, id))
  return doc
}

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Persist a batch of WireOps to the database.
 * Uses ON CONFLICT DO NOTHING for idempotency — if the op already
 * exists (duplicate delivery), it's silently skipped.
 */
export async function insertOps(
  db: DB,
  docId: string,
  wireOps: WireOp[],
): Promise<void> {
  if (wireOps.length === 0) return

  const rows: schema.NewOperation[] = wireOps.map(op => ({
    docId,
    agentId: op.agentId,
    seq: op.seq,
    type: op.type,
    pos: op.pos,
    content: op.content ?? null,
    parentIds: op.parentIds,
  }))

  await db
    .insert(schema.operations)
    .values(rows)
    .onConflictDoNothing({ target: [schema.operations.agentId, schema.operations.seq] })
}

/**
 * Load all ops for a document, ordered by their database-insert order
 * (which preserves causal ordering because servers enforce seq monotonicity).
 */
export async function getAllOps(db: DB, docId: string): Promise<WireOp[]> {
  const rows = await db
    .select()
    .from(schema.operations)
    .where(eq(schema.operations.docId, docId))
    .orderBy(schema.operations.id) // serial PK preserves insertion order

  return rows.map(rowToWireOp)
}

/**
 * Get only the ops that the client doesn't have yet (for catch-up).
 * `theirVersions` maps agentId → highest seq they have.
 * We return any op whose seq > that value, OR whose agent is unknown to them.
 */
export async function getMissingOps(
  db: DB,
  docId: string,
  theirVersions: VersionMap,
): Promise<WireOp[]> {
  const entries = Object.entries(theirVersions)

  // All ops for this doc...
  const allRows = await db
    .select()
    .from(schema.operations)
    .where(eq(schema.operations.docId, docId))
    .orderBy(schema.operations.id)

  // ...filtered to those the client doesn't have.
  return allRows
    .filter(row => {
      const theirSeq = theirVersions[row.agentId] ?? -1
      return row.seq > theirSeq
    })
    .map(rowToWireOp)
}

function rowToWireOp(row: schema.Operation): WireOp {
  const wire: WireOp = {
    agentId: row.agentId,
    seq: row.seq,
    type: row.type as 'ins' | 'del',
    pos: row.pos,
    parentIds: row.parentIds as [string, number][],
  }
  if (row.content != null) wire.content = row.content
  return wire
}

// ─── Critical versions ────────────────────────────────────────────────────────

export async function upsertCriticalVersion(
  db: DB,
  docId: string,
  agentId: string,
  seq: number,
  snapshot: string,
): Promise<void> {
  await db
    .insert(schema.criticalVersions)
    .values({ docId, agentId, seq, snapshot })
    .onConflictDoNothing({ target: [schema.criticalVersions.agentId, schema.criticalVersions.seq] })
}

export async function getCriticalVersionsForDoc(
  db: DB,
  docId: string,
): Promise<schema.CriticalVersionRow[]> {
  return db
    .select()
    .from(schema.criticalVersions)
    .where(eq(schema.criticalVersions.docId, docId))
    .orderBy(schema.criticalVersions.id)
}
