import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { broadcastOps } from '../sync/syncManager'
import { CursorOverlay } from './CursorOverlay'
import { checkoutFancy } from '@syncpad/egwalker-core'

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
  // IMPORTANT: Do NOT subscribe to `peers` here!
  // Subscribing to peers here would cause the entire <textarea> to re-render 
  // on every single mouse movement of a remote user, causing severe main thread lag.
  const { doc, docVersion, updatePeerCursor, agentId, timeTravelFrontier, setTimeTravelFrontier } = useStore(state => ({
    doc: state.doc,
    docVersion: state.docVersion,
    updatePeerCursor: state.updatePeerCursor,
    agentId: state.agentId,
    timeTravelFrontier: state.timeTravelFrontier,
    setTimeTravelFrontier: state.setTimeTravelFrontier
  }))
  
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  // Local state to prevent React cursor jumping
  const [localText, setLocalText] = useState('')
  // Dummy state just to trigger overlay re-position on scroll
  const [scrollTrigger, setScrollTrigger] = useState(0)
  
  // Sync from CRDT to local state
  useEffect(() => {
    if (doc) {
      if (timeTravelFrontier) {
        const branch = { snapshot: [], frontier: [] }
        checkoutFancy(doc.oplog, branch, timeTravelFrontier)
        setLocalText(branch.snapshot.join(''))
      } else {
        setLocalText(doc.getText())
      }
    }
  }, [doc, docVersion, timeTravelFrontier])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!doc || !agentId) return
    if (timeTravelFrontier !== null) {
      setTimeTravelFrontier(null)
      setLocalText(doc.getText())
      return
    }
    
    const newText = e.target.value
    const diff = calcDiff(doc.getText(), newText)
    
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!doc) return
    
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        let ops
        if (e.shiftKey) {
          ops = doc.redo()
        } else {
          ops = doc.undo()
        }
        
        if (ops && ops.length > 0) {
          setLocalText(doc.getText())
          useStore.getState().incDocVersion()
          broadcastOps(ops)
        }
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault()
        const ops = doc.redo()
        if (ops && ops.length > 0) {
          setLocalText(doc.getText())
          useStore.getState().incDocVersion()
          broadcastOps(ops)
        }
      }
    }
  }

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const cursor = (e.target as HTMLTextAreaElement).selectionStart
    if (agentId) {
      updatePeerCursor(agentId, cursor)
    }
  }

  const handleScroll = () => {
    setScrollTrigger(prev => prev + 1)
  }

  return (
    <div className="flex-1 p-6 flex flex-col h-full bg-white shadow-sm border-r border-gray-200 z-10 relative overflow-hidden">
      {timeTravelFrontier !== null && (
        <div className="mb-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 flex justify-between items-center z-20">
          <span>Viewing historical snapshot (Time Travel). Click editor or button to return to live editing.</span>
          <button
            onClick={() => setTimeTravelFrontier(null)}
            className="ml-2 px-2 py-0.5 bg-amber-600 text-white rounded hover:bg-amber-700 font-medium"
          >
            Return to Live
          </button>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={localText}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (timeTravelFrontier !== null) {
            setTimeTravelFrontier(null)
          }
        }}
        onSelect={handleSelect}
        onClick={handleSelect}
        onKeyUp={handleSelect}
        onScroll={handleScroll}
        className={`w-full h-full resize-none outline-none text-gray-800 text-lg font-mono leading-relaxed bg-transparent z-10 relative ${timeTravelFrontier ? 'opacity-60' : ''}`}
        placeholder="Start typing..."
        spellCheck={false}
      />
      <CursorOverlay 
        textareaRef={textareaRef} 
        localText={localText} 
        docVersion={docVersion + scrollTrigger} 
      />
    </div>
  )
}
