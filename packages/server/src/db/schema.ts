/**
 * PostgreSQL schema (Drizzle ORM).
 *
 * Three tables:
 * - documents:        one row per document (id, name, timestamps)
 * - operations:       the persistent oplog — one row per op, append-only
 * - critical_versions: server-side checkpoints for cold-start acceleration
 */

import {
  pgTable, text, serial, integer, jsonb,
  timestamp, unique, index,
} from 'drizzle-orm/pg-core'

// ─── Documents ────────────────────────────────────────────────────────────────

export const documents = pgTable('documents', {
  id:        text('id').primaryKey(),              // UUID chosen by client
  name:      text('name').notNull().default('Untitled'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ─── Operations (the persistent oplog) ───────────────────────────────────────

export const operations = pgTable(
  'operations',
  {
    id:        serial('id').primaryKey(),
    docId:     text('doc_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
    agentId:   text('agent_id').notNull(),
    seq:       integer('seq').notNull(),
    type:      text('type').notNull(),             // 'ins' | 'del'
    pos:       integer('pos').notNull(),
    content:   text('content'),                    // NULL for deletions
    /**
     * Portable parent references: [[agentId, seq], ...]
     * Stored as JSONB — never raw LVs.
     */
    parentIds: jsonb('parent_ids').notNull().$type<[string, number][]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Each (agentId, seq) pair is globally unique — idempotent inserts.
    agentSeqUnique: unique('ops_agent_seq_unique').on(t.agentId, t.seq),
    // Fast lookup of all ops for a document (for catch-up).
    docIdIdx: index('ops_doc_id_idx').on(t.docId),
    // Fast lookup of ops by agent (for version checking).
    agentSeqIdx: index('ops_agent_seq_idx').on(t.agentId, t.seq),
  }),
)

// ─── Critical versions ────────────────────────────────────────────────────────

export const criticalVersions = pgTable(
  'critical_versions',
  {
    id:          serial('id').primaryKey(),
    docId:       text('doc_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
    agentId:     text('agent_id').notNull(),       // The op's agent
    seq:         integer('seq').notNull(),          // The op's seq
    /**
     * The full document text at this critical version.
     * Allows the server to skip re-walking all prior ops on cold start.
     */
    snapshot:    text('snapshot').notNull(),
    createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    docIdIdx: index('cv_doc_id_idx').on(t.docId),
    agentSeqUnique: unique('cv_agent_seq_unique').on(t.agentId, t.seq),
  }),
)

// ─── TypeScript types inferred from schema ────────────────────────────────────

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
export type Operation = typeof operations.$inferSelect
export type NewOperation = typeof operations.$inferInsert
export type CriticalVersionRow = typeof criticalVersions.$inferSelect
export type NewCriticalVersion = typeof criticalVersions.$inferInsert
