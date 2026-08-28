import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { broadcastOps } from '../sync/syncManager'

// Simple diffing algorithm for single contiguous edits in a textarea
function calcDiff(oldStr: string, newStr: string) {
  let start = 0
  while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
    start++
  }
  
  let oldEnd = oldStr.length - 1
  let newEnd = newStr.length - 1
  while (oldEnd >= start && newEnd >= start && oldStr[oldEnd] === newStr[newEnd]) {
    oldEnd--
    newEnd--
  }
  
  const deletedCount = oldEnd - start + 1
  const insertedStr = newStr.slice(start, newEnd + 1)
  
  return { pos: start, deletedCount, insertedStr }
}

export function Editor() {
  const { doc, docVersion, updatePeerCursor, agentId } = useStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  // Local state to prevent React cursor jumping
  const [localText, setLocalText] = useState('')
  
  // Sync from CRDT to local state
  useEffect(() => {
    if (doc) {
      setLocalText(doc.getText())
    }
  }, [doc, docVersion])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!doc || !agentId) return
    
    const newText = e.target.value
    const diff = calcDiff(localText, newText)
    
    let wireOps: any[] = []
    
    if (diff.deletedCount > 0) {
      wireOps.push(...doc.delete(diff.pos, diff.deletedCount))
    }
    if (diff.insertedStr.length > 0) {
      wireOps.push(...doc.insert(diff.pos, diff.insertedStr))
    }
    
    setLocalText(newText)
    
    if (wireOps.length > 0) {
      useStore.getState().incDocVersion()
      broadcastOps(wireOps)
    }
  }

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const cursor = (e.target as HTMLTextAreaElement).selectionStart
    if (agentId) {
      updatePeerCursor(agentId, cursor)
    }
  }

  return (
    <div className="flex-1 p-6 flex flex-col h-full bg-white shadow-sm border-r border-gray-200 z-10 relative">
      <textarea
        ref={textareaRef}
        value={localText}
        onChange={handleChange}
        onSelect={handleSelect}
        onClick={handleSelect}
        onKeyUp={handleSelect}
        className="w-full h-full resize-none outline-none text-gray-800 text-lg font-mono leading-relaxed"
        placeholder="Start typing..."
        spellCheck={false}
      />
    </div>
  )
}
