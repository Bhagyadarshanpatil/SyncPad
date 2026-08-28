import { useMemo } from 'react'
import ReactFlow, { Background, Controls, MarkerType } from 'reactflow'
import 'reactflow/dist/style.css'
import { useStore } from '../store'

export function DagViewer() {
  const { doc, docVersion } = useStore()

  const { nodes, edges } = useMemo(() => {
    if (!doc) return { nodes: [], edges: [] }

    const nodes = []
    const edges = []
    
    // We'll layout nodes purely vertically by sequence number for simplicity,
    // and horizontally by agent ID.
    const agentCols = new Map<string, number>()
    let currentX = 0

    for (let lv = 0; lv < doc.oplog.ops.length; lv++) {
      const op = doc.oplog.ops[lv]
      const agentId = op.id[0]
      const seq = op.id[1]

      if (!agentCols.has(agentId)) {
        agentCols.set(agentId, currentX)
        currentX += 200
      }
      
      const x = agentCols.get(agentId)!
      const y = seq * 80

      const isConflict = op.parents.length > 1

      // Try to find a human-readable name from the active peers list
      const peer = useStore.getState().peers.find(p => p.agentId === agentId)
      const labelPrefix = peer ? peer.name.split(' ')[0] : agentId.slice(0, 4)

      nodes.push({
        id: lv.toString(),
        position: { x, y },
        data: { 
          label: `${labelPrefix}:${seq}\n${op.type === 'ins' ? `INS '${op.content}'` : `DEL ${op.pos}`}`
        },
        style: {
          background: isConflict ? '#fef08a' : '#fff', // yellow-200 for conflicts
          border: '1px solid #ccc',
          borderRadius: isConflict ? '50%' : '4px', // Diamond effect approximation
          width: 100,
          textAlign: 'center' as const,
          fontSize: 12,
        },
      })

      for (const parentLv of op.parents) {
        edges.push({
          id: `e${parentLv}-${lv}`,
          source: parentLv.toString(),
          target: lv.toString(),
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: isConflict
        })
      }
    }

    return { nodes, edges }
  }, [doc, docVersion])

  return (
    <div className="flex-1 h-full bg-gray-50 relative border-l border-gray-200">
      <div className="absolute top-0 left-0 right-0 p-2 bg-gray-100 border-b border-gray-300 z-10 text-xs text-gray-500 font-semibold uppercase tracking-wider flex justify-between">
        <span>Operation DAG</span>
        <span>{nodes.length} ops</span>
      </div>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background color="#ccc" gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  )
}
