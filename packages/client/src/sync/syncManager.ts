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
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return btoa(binary)
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
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let syncSessionId = 0

function tryReconnectExistingSession(force = false) {
  const store = useStore.getState()
  if (
    store.docId &&
    store.agentId &&
    store.doc &&
    (force || !ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING))
  ) {
    console.log('[sync] Reconnecting existing session (force=' + force + ')')
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    connectWs(store.docId, store.agentId, store.doc)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => {
    console.log('[sync] Browser offline event fired — closing socket')
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    clearInterval(pingInterval)
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
    useStore.getState().setStatus('offline')
  })

  window.addEventListener('online', () => {
    console.log('[sync] Browser online event fired — forcing reconnect & sync')
    tryReconnectExistingSession(true)
  })
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'trigger-sync') {
      console.log('[sync] Received trigger-sync from SW')
      tryReconnectExistingSession()
    }
  })
}

export async function initSync(docId: string): Promise<void> {
  const mySessionId = ++syncSessionId
  const store = useStore.getState()
  store.setStatus('connecting')
  
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
  if (mySessionId !== syncSessionId) {
    // Cancelled by closeSync() or superseded by a newer initSync() (e.g. React StrictMode)
    return
  }

  const offlineOps = offlineRecs.map(r => r.op)
  if (offlineOps.length > 0) {
    console.log(`[sync] Loaded ${offlineOps.length} offline ops from IDB`)
    doc.applyRemote(offlineOps)
    store.incDocVersion()
  }

  // 3. Connect WebSocket
  connectWs(docId, agentId, doc)
}

function connectWs(docId: string, agentId: string, doc: CRDTDocument) {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  
  // Use VITE_WS_URL if provided (e.g. for production Cloud Run direct connection)
  // Otherwise default to local dev or same-origin
  const wsUrl = import.meta.env.VITE_WS_URL 
    ? import.meta.env.VITE_WS_URL
    : import.meta.env.DEV 
      ? `ws://localhost:3001/ws` 
      : `${protocol}//${window.location.host}/ws`

  const socket = new WebSocket(wsUrl)
  ws = socket
  const store = useStore.getState()

  socket.onopen = async () => {
    if (ws !== socket) return
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

    // Query IndexedDB for any un-ACKed offline ops and send them as catchup
    const offlineRecs = await getOfflineOps(docId)
    const pendingOfflineOps = offlineRecs.map(r => r.op)
    if (ws === socket && socket.readyState === WebSocket.OPEN && pendingOfflineOps.length > 0) {
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

  socket.onmessage = async (e) => {
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

          // If any ops are still stuck in outOfOrderBuffer (e.g. we missed earlier ops while briefly offline),
          // request a catchup from the server by sending our current knownVersions.
          if (currentDoc.outOfOrderBuffer.size > 0 && store.user?.token) {
            console.log(`[sync] ${currentDoc.outOfOrderBuffer.size} ops in outOfOrderBuffer — requesting catchup`)
            sendMsg({
              type: 'join',
              docId,
              agentId,
              knownVersions: getVersionMap(currentDoc.oplog),
              token: store.user.token
            })
          }
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

  socket.onclose = () => {
    if (ws !== socket) return
    store.setStatus('offline')
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (typeof navigator === 'undefined' || navigator.onLine) {
      reconnectTimeout = setTimeout(() => connectWs(docId, agentId, doc), 3000) // Reconnect loop
    }
  }

  socket.onerror = () => {
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
  syncSessionId++ // Invalidate any in-flight initSync
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
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
  
  const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine
  console.log(`[sync] Broadcasting ${ops.length} ops, wsState=${ws?.readyState}, online=${isOnline}`)
  
  // 1. Optimistically save to IDB in case we're offline
  await saveOfflineOps(docId, ops)
  
  // 2. Send over WS (include any earlier un-ACKed ops from IDB so sequence gaps never happen)
  if (isOnline && ws?.readyState === WebSocket.OPEN) {
    const offlineRecs = await getOfflineOps(docId)
    const pendingOps = offlineRecs.length > 0 ? offlineRecs.map(r => r.op) : ops
    sendMsg({
      type: 'ops',
      docId,
      ops: pendingOps
    })
  } else {
    if (!isOnline && ws) {
      ws.onclose = null
      ws.close()
      ws = null
      store.setStatus('offline')
    }
    console.warn(`[sync] Offline or WS not open (state=${ws?.readyState}, online=${isOnline}), ops saved to IDB only`)
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
