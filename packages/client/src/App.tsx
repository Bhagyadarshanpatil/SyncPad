import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Editor } from './components/Editor'
import { DagViewer } from './components/DagViewer'
import { StatusBar } from './components/StatusBar'
import { Login } from './components/Login'
import { initSync, closeSync } from './sync/syncManager'
import { useStore } from './store'

function App() {
  const { docId, user, setUser } = useStore()
  const [copied, setCopied] = useState(false)

  // Rehydrate user session on mount
  useEffect(() => {
    const saved = localStorage.getItem('syncpad:user')
    if (saved && !user) {
      setUser(JSON.parse(saved))
    }
  }, [user, setUser])

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    if (!user) return
    
    // Basic routing: if hash is empty, generate a new room ID and update hash
    let id = window.location.hash.slice(1)
    if (!id) {
      id = uuid()
      window.location.hash = id
    }
    
    // Listen for hash changes to join new rooms
    const handleHashChange = () => {
      const newId = window.location.hash.slice(1)
      if (newId) {
        closeSync()
        initSync(newId)
      }
    }
    window.addEventListener('hashchange', handleHashChange)
    
    // Initial load
    initSync(id)

    return () => {
      window.removeEventListener('hashchange', handleHashChange)
      closeSync()
    }
  }, [user]) // Re-run if user logs in

  if (!user) return <Login />
  if (!docId) return <div className="h-full flex items-center justify-center text-gray-500">Loading SyncPad...</div>

  return (
    <div className="flex flex-col h-full bg-gray-100">
      <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 justify-between shrink-0">
        <h1 className="font-bold text-gray-800 tracking-tight">SyncPad</h1>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-400 font-mono hidden sm:inline-block">Room: {docId}</span>
          <button 
            onClick={copyLink}
            className="text-xs px-3 py-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md font-medium transition-colors border border-blue-200"
          >
            {copied ? 'Copied!' : 'Copy Invite Link'}
          </button>
        </div>
      </header>
      
      <main className="flex-1 flex overflow-hidden">
        <div className="w-1/2 flex flex-col relative">
          <Editor />
        </div>
        <div className="w-1/2 flex flex-col">
          <DagViewer />
        </div>
      </main>

      <StatusBar />
    </div>
  )
}

export default App
