/**
 * Columnar binary encoder for bulk OpLog transfer.
 *
 * Used for:
 * - Reconnect catch-up (client sends its offline ops as a compact binary blob)
 * - Initial join catch-up (server sends the full history compressed)
 * - .syncpad file export/import
 *
 * NOT used for real-time per-keystroke streaming (plain JSON WireOp for that).
 *
 * Format:
 *   [Header 12 bytes]
 *   [Metadata column: varint stream]
 *   [Content column: LZ4-compressed UTF-8 chars from all inserts]
 *   [Topology column: exception list for non-sequential parents]
 */

import { compress, decompress } from 'lz4js'
import type { OpLog, WireOp } from './types.js'
import { oplogToWireOps } from './oplog.js'

// ─── Varint encoding ──────────────────────────────────────────────────────────

function writeVarint(buf: number[], value: number): void {
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  buf.push(value & 0x7f)
}

function readVarint(data: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let byte: number
  do {
    byte = data[offset++]
    value |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return { value, offset }
}

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Sort WireOps in topological order (each op after all its parents).
 * Kahn's algorithm on the parentIds graph.
 */
export function topoSort(ops: WireOp[]): WireOp[] {
  // Build index: agentId+seq → index in ops array.
  const idx = new Map<string, number>()
  for (let i = 0; i < ops.length; i++) {
    idx.set(`${ops[i].agentId}:${ops[i].seq}`, i)
  }

  const inDegree = new Array<number>(ops.length).fill(0)
  const children: number[][] = Array.from({ length: ops.length }, () => [])

  for (let i = 0; i < ops.length; i++) {
    for (const [a, s] of ops[i].parentIds) {
      const pi = idx.get(`${a}:${s}`)
      if (pi != null) {
        inDegree[i]++
        children[pi].push(i)
      }
    }
  }

  const queue: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (inDegree[i] === 0) queue.push(i)
  }

  const sorted: WireOp[] = []
  while (queue.length > 0) {
    const i = queue.shift()!
    sorted.push(ops[i])
    for (const c of children[i]) {
      if (--inDegree[c] === 0) queue.push(c)
    }
  }

  return sorted
}

// ─── Encode ───────────────────────────────────────────────────────────────────

const MAGIC = 0x53504144 // 'SPAD'
const VERSION = 1

export interface EncodedOpLog {
  /** The full binary blob, ready to send as ArrayBuffer / Buffer. */
  buffer: Uint8Array
  /** Number of ops encoded. */
  opCount: number
}

/**
 * Encode an oplog into the columnar binary format.
 */
export function encodeOpLog(oplog: OpLog): EncodedOpLog {
  const wireOps = oplogToWireOps(oplog)
  return encodeWireOps(wireOps)
}

export function encodeWireOps(wireOps: WireOp[]): EncodedOpLog {
  const sorted = topoSort(wireOps)

  // Build topo-index map: agentId:seq → index in sorted array.
  const topoIdx = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    topoIdx.set(`${sorted[i].agentId}:${sorted[i].seq}`, i)
  }

  // ── Metadata column ──────────────────────────────────────────────────────
  // Per op: [type:1bit | pos:varint | runLength:varint | agentIdLen:varint | agentId:utf8 | seq:varint]
  const metaBuf: number[] = []
  // ── Content column (raw chars, to be LZ4-compressed) ────────────────────
  let contentStr = ''
  // ── Topology column (exceptions to "parent = predecessor") ──────────────
  const topoExceptions: Array<{ opIdx: number; parentIdxs: number[] }> = []

  for (let i = 0; i < sorted.length; i++) {
    const op = sorted[i]

    // Metadata: type bit.
    metaBuf.push(op.type === 'ins' ? 0 : 1)

    // Metadata: pos.
    writeVarint(metaBuf, op.pos)

    // Run length: 1 for now (future: merge consecutive ops from same agent).
    writeVarint(metaBuf, 1)

    // Agent ID (length-prefixed UTF-8).
    const agentBytes = new TextEncoder().encode(op.agentId)
    writeVarint(metaBuf, agentBytes.length)
    for (const b of agentBytes) metaBuf.push(b)

    // Seq.
    writeVarint(metaBuf, op.seq)

    // Content column.
    if (op.type === 'ins' && op.content != null) {
      contentStr += op.content
    }

    // Topology: check if parent is simply the predecessor.
    const defaultParent = i === 0 ? [] : [`${sorted[i - 1].agentId}:${sorted[i - 1].seq}`]
    const actualParents = op.parentIds.map(([a, s]) => `${a}:${s}`)

    const isDefault =
      actualParents.length === defaultParent.length &&
      actualParents.every(p => defaultParent.includes(p))

    if (!isDefault) {
      topoExceptions.push({
        opIdx: i,
        parentIdxs: op.parentIds.map(([a, s]) => topoIdx.get(`${a}:${s}`) ?? -1),
      })
    }
  }

  // ── LZ4 compression for content ──────────────────────────────────────────
  const uncompressedContent = new TextEncoder().encode(contentStr)
  const contentBytes = compress(uncompressedContent)

  // ── Topology column serialisation ─────────────────────────────────────────
  const topoBuf: number[] = []
  writeVarint(topoBuf, topoExceptions.length)
  for (const ex of topoExceptions) {
    writeVarint(topoBuf, ex.opIdx)
    writeVarint(topoBuf, ex.parentIdxs.length)
    for (const pi of ex.parentIdxs) writeVarint(topoBuf, pi < 0 ? 0xffffffff : pi)
  }

  // ── Assemble header + columns ─────────────────────────────────────────────
  const header = new DataView(new ArrayBuffer(16))
  header.setUint32(0, MAGIC, false)
  header.setUint16(4, VERSION, false)
  header.setUint32(6, sorted.length, false)
  header.setUint32(10, contentBytes.length, false)
  // (2 bytes padding / future use)

  const metaArr = new Uint8Array(metaBuf)
  const topoArr = new Uint8Array(topoBuf)

  const total = 16 + metaArr.length + contentBytes.length + topoArr.length
  const out = new Uint8Array(total)
  let off = 0
  out.set(new Uint8Array(header.buffer), off); off += 16
  out.set(metaArr, off); off += metaArr.length
  out.set(contentBytes, off); off += contentBytes.length
  out.set(topoArr, off)

  return { buffer: out, opCount: sorted.length }
}

// ─── Decode ───────────────────────────────────────────────────────────────────

export function decodeOpLog(buffer: Uint8Array): WireOp[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  const magic = view.getUint32(0, false)
  if (magic !== MAGIC) throw new Error('Invalid SyncPad binary format (bad magic)')

  const _version = view.getUint16(4, false)
  const opCount = view.getUint32(6, false)
  const contentByteLen = view.getUint32(10, false)

  let off = 16

  // Decode metadata column.
  const metaOps: Array<{
    type: 'ins' | 'del'
    pos: number
    runLength: number
    agentId: string
    seq: number
  }> = []

  for (let i = 0; i < opCount; i++) {
    const type = buffer[off++] === 0 ? 'ins' : 'del'

    let r = readVarint(buffer, off); const pos = r.value; off = r.offset
    r = readVarint(buffer, off); const runLength = r.value; off = r.offset
    r = readVarint(buffer, off); const agentIdLen = r.value; off = r.offset

    const agentId = new TextDecoder().decode(buffer.slice(off, off + agentIdLen))
    off += agentIdLen

    r = readVarint(buffer, off); const seq = r.value; off = r.offset

    metaOps.push({ type, pos, runLength, agentId, seq })
  }

  // Decode content column.
  const compressedContent = buffer.slice(off, off + contentByteLen)
  const decompressedContent = decompress(compressedContent)
  const contentStr = new TextDecoder().decode(decompressedContent)
  off += contentByteLen
  const contentChars = [...contentStr]

  // Decode topology column.
  let tr = readVarint(buffer, off); const numExceptions = tr.value; off = tr.offset
  const exceptions = new Map<number, number[]>()
  for (let i = 0; i < numExceptions; i++) {
    tr = readVarint(buffer, off); const opIdx = tr.value; off = tr.offset
    tr = readVarint(buffer, off); const numParents = tr.value; off = tr.offset
    const parents: number[] = []
    for (let j = 0; j < numParents; j++) {
      tr = readVarint(buffer, off); parents.push(tr.value); off = tr.offset
    }
    exceptions.set(opIdx, parents)
  }

  // Reconstruct WireOps.
  const wireOps: WireOp[] = []
  let contentIdx = 0

  for (let i = 0; i < metaOps.length; i++) {
    const m = metaOps[i]

    // Default parent is the predecessor op.
    let parentIdxs: number[]
    if (exceptions.has(i)) {
      parentIdxs = exceptions.get(i)!
    } else if (i === 0) {
      parentIdxs = []
    } else {
      parentIdxs = [i - 1]
    }

    const parentIds: [string, number][] = parentIdxs
      .filter(pi => pi !== 0xffffffff)
      .map(pi => [metaOps[pi].agentId, metaOps[pi].seq])

    const wire: WireOp = {
      agentId: m.agentId,
      seq: m.seq,
      type: m.type,
      pos: m.pos,
      parentIds,
    }

    if (m.type === 'ins') {
      wire.content = contentChars[contentIdx++] ?? ''
    }

    wireOps.push(wire)
  }

  return wireOps
}
