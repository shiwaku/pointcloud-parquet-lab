// Parquet の読み取りと配列変換を行う Web Worker (module worker)。
// hyparquet で footer と row group を HTTP range request で部分読みし、
// points.js で deck.gl 用のバイナリに変換してメインスレッドへ転送する。
import { asyncBufferFromUrl, parquetMetadataAsync, parquetRead } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.29.2/+esm'
import { compressors } from 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm'
import { summarizeMetadata, chunksToBinary } from './points.js'

const COLUMNS = ['geometry', 'Red', 'Green', 'Blue', 'Classification']

/** url → { file, metadata, summary } */
const files = new Map()

async function open(url) {
  let entry = files.get(url)
  if (entry) return entry
  const file = await asyncBufferFromUrl({ url })
  const metadata = await parquetMetadataAsync(file)
  const summary = summarizeMetadata(metadata)
  entry = { file, metadata, summary }
  files.set(url, entry)
  return entry
}

self.onmessage = async e => {
  const msg = e.data
  try {
    if (msg.type === 'open') {
      const { summary } = await open(msg.url)
      self.postMessage({ type: 'opened', id: msg.id, url: msg.url, summary })
    } else if (msg.type === 'load') {
      const { file, metadata, summary } = await open(msg.url)
      const rg = summary.rgs[msg.rg]
      const chunks = []
      const t0 = performance.now()
      if (msg.debug) console.log(`[worker] load rg ${msg.rg} start`)
      await parquetRead({
        file, metadata, compressors,
        rowStart: rg.rowStart, rowEnd: rg.rowEnd,
        columns: COLUMNS,
        onChunk: c => chunks.push(c),
      })
      const colorShift = summary.colorMax > 255 ? 8 : 0
      if (msg.debug) console.log(`[worker] load rg ${msg.rg} read done ${(performance.now() - t0).toFixed(0)} ms, chunks ${chunks.length}`)
      const bin = chunksToBinary(chunks, msg.center, colorShift)
      if (msg.debug) console.log(`[worker] load rg ${msg.rg} converted ${(performance.now() - t0).toFixed(0)} ms`)
      self.postMessage(
        { type: 'loaded', id: msg.id, url: msg.url, rg: msg.rg, bytes: rg.bytes, ms: performance.now() - t0, ...bin },
        [bin.positions.buffer, bin.rgb.buffer, bin.cls.buffer],
      )
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, url: msg.url, rg: msg.rg, message: String(err?.stack || err) })
  }
}
