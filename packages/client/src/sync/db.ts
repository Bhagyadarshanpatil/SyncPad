import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { WireOp } from '@syncpad/egwalker-core'

export interface OfflineOpRec {
  id?: number
  docId: string
  op: WireOp
}

interface SyncPadDB extends DBSchema {
  metadata: {
    key: string // e.g. 'agentId:<docId>'
    value: string
  }
  offlineOps: {
    key: number // auto-increment
    value: OfflineOpRec
    indexes: { 'by-doc': string }
  }
}

let dbPromise: Promise<IDBPDatabase<SyncPadDB>> | null = null

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<SyncPadDB>('syncpad-db', 1, {
      upgrade(db) {
        db.createObjectStore('metadata')
        const opsStore = db.createObjectStore('offlineOps', {
          keyPath: 'id',
          autoIncrement: true,
        })
        opsStore.createIndex('by-doc', 'docId')
      },
    })
  }
  return dbPromise
}

export async function getSavedAgentId(docId: string): Promise<string | null> {
  const db = await getDB()
  const val = await db.get('metadata', `agentId:${docId}`)
  return val ?? null
}

export async function saveAgentId(docId: string, agentId: string): Promise<void> {
  const db = await getDB()
  await db.put('metadata', agentId, `agentId:${docId}`)
}

export async function saveOfflineOps(docId: string, ops: WireOp[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('offlineOps', 'readwrite')
  for (const op of ops) {
    await tx.store.add({ docId, op })
  }
  await tx.done
}

export async function getOfflineOps(docId: string): Promise<OfflineOpRec[]> {
  const db = await getDB()
  return db.getAllFromIndex('offlineOps', 'by-doc', docId)
}

export async function deleteOfflineOps(ids: number[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('offlineOps', 'readwrite')
  for (const id of ids) {
    await tx.store.delete(id)
  }
  await tx.done
}
