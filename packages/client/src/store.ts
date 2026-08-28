import { create } from 'zustand'
import { CRDTDocument, type PeerInfo } from '@syncpad/egwalker-core'

export interface SyncPadState {
  user: { id: string; name: string; picture?: string; token: string } | null
  setUser: (user: SyncPadState['user']) => void
  
  docId: string | null
  agentId: string | null
  status: 'connecting' | 'connected' | 'offline' | 'error'
  
  // The core CRDT document instance
  doc: CRDTDocument | null
  
  // To trigger re-renders when doc changes
  docVersion: number
  
  // Time travel
  timeTravelFrontier: number[] | null
  
  peers: PeerInfo[]
  
  // Actions
  setDocId: (id: string) => void
  setAgentId: (id: string) => void
  setStatus: (status: SyncPadState['status']) => void
  setDoc: (doc: CRDTDocument) => void
  incDocVersion: () => void
  setTimeTravelFrontier: (frontier: number[] | null) => void
  setPeers: (peers: PeerInfo[]) => void
  updatePeerCursor: (agentId: string, cursor: number) => void
}

export const useStore = create<SyncPadState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  
  docId: null,
  agentId: null,
  status: 'connecting',
  doc: null,
  docVersion: 0,
  timeTravelFrontier: null,
  peers: [],

  setDocId: (id) => set({ docId: id }),
  setAgentId: (id) => set({ agentId: id }),
  setStatus: (status) => set({ status }),
  setDoc: (doc) => set({ doc }),
  incDocVersion: () => set((state) => ({ docVersion: state.docVersion + 1 })),
  setTimeTravelFrontier: (frontier) => set({ timeTravelFrontier: frontier }),
  setPeers: (peers) => set({ peers }),
  updatePeerCursor: (agentId, cursor) => set((state) => {
    const peers = [...state.peers]
    const idx = peers.findIndex(p => p.agentId === agentId)
    if (idx !== -1) {
      peers[idx] = { ...peers[idx], cursor }
    }
    return { peers }
  }),
}))
