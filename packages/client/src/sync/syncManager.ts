import { v4 as uuid } from 'uuid'
import {
  CRDTDocument,
  getVersionMap,
  type ClientMessage,
  type ServerMessage,
  type WireOp,
  encodeWireOps,
  decodeOpLog
} from '@syncpad/egwalker-core'
import { useStore } from '../store'
import {
  saveOfflineOps,
  getOfflineOps,
  deleteOfflineOps
} from './db'

// Helper to convert Uint8Array to base64
function toBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode.apply(null, arr as any))
}

// Helper to convert base64 to Uint8Array
function fromBase64(b64: string): Uint8Array {
  const str = atob(b64)
  const arr = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i)
  }
  return arr
}

let ws: WebSocket | null = null
let pingInterval: ReturnType<typeof setInterval>
let isInitializing = false

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'trigger-sync') {
      console.log('[sync] Received trigger-sync from SW')
      const store = useStore.getState()
      if (store.docId && (!ws || ws.readyState === WebSocket.CLOSED)) {
        console.log('[sync] Reconnecting due to background sync event')
        // Close old and re-init to pull offline ops and connect
        closeSync()
        initSync(store.docId)
      }
    }
  })
}

export async function initSync(docId: string): Promise<void> {
  // Guard: if already initializing (React StrictMode double-invoke), skip.
  if (isInitializing) {
    console.log('[sync] initSync already in progress, skipping duplicate call')
    return
  }
  isInitializing = true

  const store = useStore.getState()
  
  // 1. Setup identity and Doc
  // We ALWAYS generate a fresh replica ID (agentId) on load.
  // This guarantees that if a user duplicates a tab, it still acts as a unique replica.
  // The user's actual identity is tied to Google Auth, so they will still appear as themselves!
  const agentId = uuid()
  
  const doc = new CRDTDocument(agentId)
  store.setDocId(docId)
  store.setAgentId(agentId)
  store.setDoc(doc)

  // 2. Load offline ops from IDB (all unsynced ops for this document)
  const offlineRecs = await getOfflineOps(docId)
  const offlineOps = offlineRecs.map(r => r.op)
  if (offlineOps.length > 0) {
    console.log(`[sync] Loaded ${offlineOps.length} offline ops from IDB`)
    doc.applyRemote(offlineOps)
    store.incDocVersion()
  }

  // 3. Connect WebSocket
  connectWs(docId, agentId, doc, offlineOps)
  isInitializing = false
}

function connectWs(docId: string, agentId: string, doc: CRDTDocument, pendingOfflineOps: WireOp[]) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // In dev, proxy through Vite (ws://localhost:5173/api/ws) -> Fastify
  // Wait, vite proxy config doesn't proxy /ws by default unless configured.
  // We can just connect directly to 3001 in dev, or use Vite proxy.
  // Vite proxy is configured to rewrite ^/api to http://localhost:3001. So /api/ws works.
  const wsUrl = import.meta.env.DEV 
    ? `ws://localhost:3001/ws` 
    : `${protocol}//${window.location.host}/ws`

  ws = new WebSocket(wsUrl)
  const store = useStore.getState()

  ws.onopen = () => {
    store.setStatus('connected')
    console.log(`[sync] Connected! agentId=${agentId} docId=${docId}`)
    
    // Join room
    const knownVersions = getVersionMap(doc.oplog)
    console.log(`[sync] Sending JOIN`, { docId, agentId, knownVersions })
    sendMsg({
      type: 'join',
      docId,
      agentId,
      knownVersions,
      token: store.user?.token
    })

    // If we have pending offline ops, send them as catchup
    if (pendingOfflineOps.length > 0) {
      console.log(`[sync] Sending CATCHUP with ${pendingOfflineOps.length} offline ops`)
      const encoded = encodeWireOps(pendingOfflineOps)
      sendMsg({
        type: 'catchup',
        docId,
        encoding: 'binary',
        payload: toBase64(encoded.buffer)
      })
    }
  }

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data) as ServerMessage
    console.log(`[sync] Received:`, msg.type, msg)
    
    switch (msg.type) {
      case 'peers':
        useStore.getState().setPeers((msg as any).peers)
        break
        
      case 'ops':
      case 'catchup': {
        const currentDoc = useStore.getState().doc
        if (!currentDoc) break
        
        let opsToApply: WireOp[] = []
        if ('encoding' in msg && msg.encoding === 'binary' && msg.payload) {
          const buffer = fromBase64(msg.payload)
          opsToApply = decodeOpLog(buffer)
        } else if ('ops' in msg && msg.ops) {
          opsToApply = msg.ops
        }

        if (opsToApply.length > 0) {
          console.log(`[sync] Applying ${opsToApply.length} remote ops to doc`)
          currentDoc.applyRemote(opsToApply)
          useStore.getState().incDocVersion()
        }
        break
      }
        
      case 'cursor':
        useStore.getState().updatePeerCursor((msg as any).agentId, (msg as any).cursor)
        break
        
      case 'ack':
        await clearOfflineOps(docId, msg.opIds)
        break
        
      case 'error':
        console.error('[sync] Server error:', msg.message)
        if (msg.message.includes('uthentication')) {
          useStore.getState().setUser(null)
          localStorage.removeItem('syncpad:user')
          // Optional: we can close the socket, but the server already closes it.
        }
        break
    }
  }

  ws.onclose = () => {
    store.setStatus('offline')
    setTimeout(() => connectWs(docId, agentId, doc, []), 3000) // Reconnect loop
  }

  ws.onerror = () => {
    // onclose will handle reconnect
  }

  // Cursor ping loop
  clearInterval(pingInterval)
  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      // Find my own peer info to get name
      const me = useStore.getState().peers.find(p => p.agentId === agentId)
      if (me?.cursor !== undefined) {
        sendMsg({
          type: 'ping',
          docId,
          cursor: me.cursor,
          name: store.user?.name || me.name,
          picture: store.user?.picture
        })
      }
    }
  }, 1000)
}

export function closeSync() {
  isInitializing = false  // Allow re-init after close
  if (ws) {
    ws.onclose = null // Prevent reconnect loop
    ws.close()
    ws = null
  }
  clearInterval(pingInterval)
}

function sendMsg(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

/**
 * Called by Editor when user types.
 */
export async function broadcastOps(ops: WireOp[]) {
  const store = useStore.getState()
  const docId = store.docId
  if (!docId) return
  
  console.log(`[sync] Broadcasting ${ops.length} ops, wsState=${ws?.readyState}`)
  
  // 1. Optimistically save to IDB in case we're offline
  await saveOfflineOps(docId, ops)
  
  // 2. Send over WS
  if (ws?.readyState === WebSocket.OPEN) {
    sendMsg({
      type: 'ops',
      docId,
      ops
    })
  } else {
    console.warn(`[sync] WS not open (state=${ws?.readyState}), ops saved to IDB only`)
    // Request Background Sync if supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const registration = await navigator.serviceWorker.ready
        // @ts-ignore - TS doesn't know about sync yet by default
        await registration.sync.register('syncpad-ops')
        console.log('[sync] Background sync registered for offline ops')
      } catch (err) {
        console.error('[sync] Background sync registration failed', err)
      }
    }
  }
}

async function clearOfflineOps(docId: string, ackedIds: [string, number][]) {
  const recs = await getOfflineOps(docId)
  const toDelete = recs.filter(r => {
    return ackedIds.some(([a, s]) => r.op.agentId === a && r.op.seq === s)
  })
  
  if (toDelete.length > 0) {
    await deleteOfflineOps(toDelete.map(r => r.id!))
  }
}
