/**
 * Fastify application entry point.
 *
 * Registers:
 * - CORS plugin
 * - WebSocket plugin
 * - REST routes (POST /docs, GET /docs/:id)
 * - WebSocket route (/ws)
 */

import 'dotenv/config'
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './db/schema.js'
import { createNewDocument, ensureDocumentLoaded } from './sessions/sessionManager.js'
import { registerWsHandler } from './sync/wsHandler.js'
import { getSession, getPeersInfo } from './sessions/sessionStore.js'
import type { DB } from './db/queries.js'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  // ── Database ────────────────────────────────────────────────────────────────
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')

  // Support Cloud SQL unix sockets via ?host=/cloudsql/... in the URL
  let hostOverride: string | undefined = undefined
  try {
    const url = new URL(connectionString)
    if (url.searchParams.has('host')) {
      hostOverride = url.searchParams.get('host') || undefined
    }
  } catch (e) {
    // Ignore URL parse errors, let postgres.js handle it
  }

  const sql = postgres(connectionString, {
    max: 10,
    connect_timeout: 10,
    ...(hostOverride ? { host: hostOverride } : {})
  })
  
  // Auto-migrate on startup for Cloud Run
  console.log('Ensuring database schema exists...')
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Untitled',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    );
  `
  await sql`
    CREATE TABLE IF NOT EXISTS operations (
      id SERIAL PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      pos INTEGER NOT NULL,
      content TEXT,
      parent_ids JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
      UNIQUE (agent_id, seq)
    );
  `
  await sql`
    CREATE TABLE IF NOT EXISTS critical_versions (
      id SERIAL PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
      UNIQUE (agent_id, seq)
    );
  `
  console.log('Database schema ready.')

  const db: DB = drizzle(sql, { schema })

  // ── Fastify ─────────────────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: 'info' } })

  // Attach sessions map to app for wsHandler access.
  app.decorate('sessions', new Map())

  await app.register(fastifyCors, {
    origin: true, // Allow all origins in dev; restrict in prod.
    methods: ['GET', 'POST', 'OPTIONS'],
  })

  await app.register(fastifyWebsocket)

  // ── REST routes ─────────────────────────────────────────────────────────────

  /** Create a new document. */
  app.post<{ Body: { name?: string } }>(
    '/docs',
    { schema: { body: { type: 'object', properties: { name: { type: 'string' } } } } },
    async (req, reply) => {
      const docId = await createNewDocument(db, req.body?.name)
      return reply.status(201).send({ docId })
    },
  )

  /** Get document metadata (name, createdAt). */
  app.get<{ Params: { docId: string } }>(
    '/docs/:docId',
    async (req, reply) => {
      const session = await ensureDocumentLoaded(db, req.params.docId)
      return reply.send({
        docId: session.docId,
        text: session.doc.getText(),
        peers: getPeersInfo(session),
      })
    },
  )

  /** Health check (for Cloud Run). */
  app.get('/health', async (_req, reply) => reply.send({ ok: true }))

  // ── WebSocket ────────────────────────────────────────────────────────────────
  registerWsHandler(app, db, sql)

  // ── Start ────────────────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST })
  console.log(`SyncPad server listening on http://${HOST}:${PORT}`)
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
