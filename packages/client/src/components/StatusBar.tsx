import { useStore } from '../store'

export function StatusBar() {
  const { status, peers, agentId } = useStore()
  
  const myPeer = peers.find(p => p.agentId === agentId)
  const otherPeers = peers.filter(p => p.agentId !== agentId)

  return (
    <div className="h-10 border-t border-gray-200 bg-white flex items-center px-4 justify-between text-sm shrink-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            status === 'connected' ? 'bg-green-500' :
            status === 'connecting' ? 'bg-yellow-500' :
            'bg-red-500'
          }`} />
          <span className="text-gray-600 capitalize">{status}</span>
        </div>
        
        <div className="h-4 w-px bg-gray-300" />
        
        {myPeer && (
          <div className="flex items-center gap-1 font-medium" style={{ color: myPeer.color }}>
            {myPeer.name} (You)
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {otherPeers.length === 0 ? (
          <span className="text-gray-400">Waiting for collaborators...</span>
        ) : (
          <div className="flex -space-x-2">
            {otherPeers.map(p => (
              <div 
                key={p.agentId}
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ring-2 ring-white bg-cover bg-center overflow-hidden"
                style={{ 
                  backgroundColor: p.color,
                  backgroundImage: p.picture ? `url(${p.picture})` : 'none'
                }}
                title={p.name}
              >
                {!p.picture && p.name.split(' ').map(w => w[0]).join('')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
