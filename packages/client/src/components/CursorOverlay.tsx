import { useLayoutEffect, useState } from 'react'
import { useStore } from '../store'
import { getCaretCoordinates } from './caretHelper'

const PEER_COLORS = [
  'bg-red-500', 'bg-blue-500', 'bg-green-500', 
  'bg-yellow-500', 'bg-purple-500', 'bg-pink-500'
]

function getPeerColor(agentId: string) {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash)
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]
}

interface CursorOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement>
  localText: string
  docVersion: number
}

export function CursorOverlay({ textareaRef, localText, docVersion }: CursorOverlayProps) {
  // Subscribe specifically to peers array, so remote cursor movements 
  // only trigger re-renders of this overlay, NOT the main editor!
  const peers = useStore(state => state.peers)
  const agentId = useStore(state => state.agentId)
  
  const [cursorCoords, setCursorCoords] = useState<Record<string, { top: number, left: number, height: number }>>({})

  useLayoutEffect(() => {
    if (!textareaRef.current) return
    const el = textareaRef.current
    
    const newCoords: Record<string, { top: number, left: number, height: number }> = {}
    for (const peer of peers) {
      if (peer.agentId === agentId) continue
      if (peer.cursor !== undefined) {
        newCoords[peer.agentId] = getCaretCoordinates(el, peer.cursor)
      }
    }
    setCursorCoords(newCoords)
  }, [peers, localText, docVersion, agentId, textareaRef])

  return (
    <>
      {peers.map(peer => {
        if (peer.agentId === agentId) return null
        const coords = cursorCoords[peer.agentId]
        if (!coords) return null
        
        const scrollTop = textareaRef.current?.scrollTop || 0
        const scrollLeft = textareaRef.current?.scrollLeft || 0
        
        return (
          <div 
            key={peer.agentId}
            className={`absolute pointer-events-none transition-all duration-100 ease-out z-20 ${getPeerColor(peer.agentId)}`}
            style={{ 
              top: coords.top - scrollTop + 24, // 24px is p-6 (1.5rem)
              left: coords.left - scrollLeft + 24,
              height: coords.height,
              width: '2px'
            }}
          >
            <div className={`absolute -top-6 -left-2 px-2 py-0.5 text-xs text-white rounded whitespace-nowrap opacity-75 ${getPeerColor(peer.agentId)}`}>
              {peer.name.split(' ')[0]}
            </div>
          </div>
        )
      })}
    </>
  )
}
