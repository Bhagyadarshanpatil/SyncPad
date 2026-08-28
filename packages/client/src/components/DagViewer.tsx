import { useEffect, useState, useCallback } from 'react'
import ReactFlow, { Background, Controls, MarkerType, Handle, Position, NodeProps } from 'reactflow'
import 'reactflow/dist/style.css'
import { useStore } from '../store'

// Custom node for conflicts (amber diamond)
const MergeNode = ({ data }: NodeProps) => (
  <div
    className="dag-node dag-node--merge relative"
    style={{
      width: 100,
      height: 40,
      background: data.highlighted ? '#fbbf24' : '#fef08a',
      border: '1px solid #d97706',
      clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 10,
      textAlign: 'center',
      color: '#92400e'
    }}
    title={data.title}
  >
    <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
    <div style={{ transform: 'scale(0.8)' }}>
      {data.label}
    </div>
    <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
  </div>
)

const nodeTypes = {
  merge: MergeNode
}

export function DagViewer() {
  const { doc, docVersion, timeTravelFrontier, setTimeTravelFrontier } = useStore()

  const [nodes, setNodes] = useState<any[]>([])
  const [edges, setEdges] = useState<any[]>([])
  const [highlightedLVs, setHighlightedLVs] = useState<Set<number>>(new Set())
  const [sliderValue, setSliderValue] = useState<number>(0)
  const [maxSlider, setMaxSlider] = useState<number>(0)

  // Debounced Graph Layout
  useEffect(() => {
    if (!doc) return
    const timer = setTimeout(() => {
      const newNodes: any[] = []
      const newEdges: any[] = []
      
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
        const isHighlighted = highlightedLVs.has(lv)

        // Try to find a human-readable name from the active peers list
        const peer = useStore.getState().peers.find(p => p.agentId === agentId)
        const labelPrefix = peer ? peer.name.split(' ')[0] : agentId.slice(0, 4)
        
        const label = `${labelPrefix}:${seq}\n${op.type === 'ins' ? `INS '${op.content}'` : `DEL ${op.pos}`}`

        if (isConflict) {
          newNodes.push({
            id: lv.toString(),
            type: 'merge',
            position: { x: x - 50, y: y - 20 }, // adjust center for diamond
            data: { label, highlighted: isHighlighted, title: `Merge Node (Parents: ${op.parents.join(', ')})` }
          })
        } else {
          newNodes.push({
            id: lv.toString(),
            position: { x, y },
            data: { label },
            style: {
              background: isHighlighted ? '#bfdbfe' : '#fff',
              border: isHighlighted ? '1px solid #2563eb' : '1px solid #ccc',
              borderRadius: '4px',
              width: 100,
              textAlign: 'center' as const,
              fontSize: 12,
              opacity: (timeTravelFrontier && lv > Math.max(...timeTravelFrontier)) ? 0.3 : 1
            },
          })
        }

        for (const parentLv of op.parents) {
          const edgeHighlighted = isHighlighted && highlightedLVs.has(parentLv)
          newEdges.push({
            id: `e${parentLv}-${lv}`,
            source: parentLv.toString(),
            target: lv.toString(),
            markerEnd: { type: MarkerType.ArrowClosed, color: edgeHighlighted ? '#2563eb' : (isConflict ? '#d97706' : '#b1b1b7') },
            style: { stroke: edgeHighlighted ? '#2563eb' : (isConflict ? '#d97706' : '#b1b1b7'), strokeWidth: edgeHighlighted ? 2 : 1 },
            animated: isConflict
          })
        }
      }

      setNodes(newNodes)
      setEdges(newEdges)
      setMaxSlider(doc.oplog.ops.length - 1)
      if (timeTravelFrontier === null) {
        setSliderValue(doc.oplog.ops.length - 1)
      }
    }, 300) // 300ms debounce
    return () => clearTimeout(timer)
  }, [doc, docVersion, highlightedLVs, timeTravelFrontier])

  const handleNodeClick = useCallback((_: any, node: any) => {
    if (!doc) return
    const clickedLv = parseInt(node.id)
    const newHighlights = new Set<number>()
    
    // Walk history
    const queue = [clickedLv]
    while (queue.length > 0) {
      const lv = queue.shift()!
      if (!newHighlights.has(lv)) {
        newHighlights.add(lv)
        const op = doc.oplog.ops[lv]
        if (op) {
          queue.push(...op.parents)
        }
      }
    }
    setHighlightedLVs(newHighlights)
  }, [doc])

  const handlePaneClick = useCallback(() => {
    setHighlightedLVs(new Set())
  }, [])
  
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!doc) return
    const val = parseInt(e.target.value)
    setSliderValue(val)
    if (val === maxSlider) {
      setTimeTravelFrontier(null)
    } else {
      setTimeTravelFrontier([val])
    }
  }

  return (
    <div className="flex-1 h-full bg-gray-50 relative border-l border-gray-200 flex flex-col">
      <div className="p-2 bg-gray-100 border-b border-gray-300 z-10 text-xs text-gray-500 font-semibold uppercase tracking-wider flex justify-between items-center">
        <span>Operation DAG</span>
        <div className="flex items-center space-x-2">
          <span>Time Travel:</span>
          <input 
            type="range" 
            min="0" 
            max={maxSlider} 
            value={sliderValue}
            onChange={handleSliderChange}
            className="w-32"
          />
        </div>
        <span>{nodes.length} ops</span>
      </div>
      <div className="flex-1 relative">
        <ReactFlow 
          nodes={nodes} 
          edges={edges} 
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          fitView
        >
          <Background color="#ccc" gap={16} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}
