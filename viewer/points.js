// Parquet (GeoArrow struct<x,y,z>) の点群を deck.gl 用のバイナリ配列に変換する純粋関数群。
// hyparquet にも DOM にも依存しないので、Worker からもブラウザ本体からも Node のテストからも使える。

/**
 * hyparquet の metadata から row group ごとの空間範囲・行範囲・バイト数を取り出す。
 * @param {object} metadata parquetMetadataAsync の戻り値
 */
export function summarizeMetadata(metadata) {
  const rgs = []
  let rowStart = 0
  let colorMax = 0
  for (let i = 0; i < metadata.row_groups.length; i++) {
    const rg = metadata.row_groups[i]
    const box = {}
    let bytes = 0
    for (const c of rg.columns) {
      const m = c.meta_data
      if (!m) continue
      const name = m.path_in_schema.join('.')
      bytes += Number(m.total_compressed_size)
      const s = m.statistics
      if (!s) continue
      if (name.startsWith('geometry.')) {
        box[name.slice('geometry.'.length)] = [num(s.min_value ?? s.min), num(s.max_value ?? s.max)]
      } else if (name === 'Red' || name === 'Green' || name === 'Blue') {
        colorMax = Math.max(colorMax, num(s.max_value ?? s.max))
      }
    }
    if (!box.x || !box.y || !box.z) {
      throw new Error(`row group ${i}: geometry.x/y/z の統計が無い (GeoArrow struct の点群ではない?)`)
    }
    const rows = Number(rg.num_rows)
    rgs.push({
      index: i, rows, bytes, rowStart, rowEnd: rowStart + rows,
      min: [box.x[0], box.y[0], box.z[0]],
      max: [box.x[1], box.y[1], box.z[1]],
    })
    rowStart += rows
  }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const rg of rgs) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], rg.min[k])
      max[k] = Math.max(max[k], rg.max[k])
    }
  }
  const center = [0, 1, 2].map(k => (min[k] + max[k]) / 2)
  const geoRaw = metadata.key_value_metadata?.find(k => k.key === 'geo')?.value
  let geo = null
  try { geo = geoRaw ? JSON.parse(geoRaw) : null } catch { geo = null }
  return { rows: Number(metadata.num_rows), rgs, min, max, center, colorMax, geo }
}

function num(v) {
  return typeof v === 'bigint' ? Number(v) : Number(v)
}

/**
 * onChunk で集めた列データを 1 row group 分のバイナリにする。
 * positions は center を引いた相対座標 (Float32 の精度対策)。
 * @param {Array<{columnName: string, rowStart: number, columnData: any[]}>} chunks
 * @param {number[]} center [cx, cy, cz]
 * @param {number} colorShift RGB が 16 bit なら 8、8 bit なら 0
 * @param {{transform?: (x:number, y:number) => number[], float64?: boolean}} [opts]
 *   transform: 平面座標 → [経度, 緯度] (MapLibre 版で使う。z はそのまま)。
 *   float64: positions を Float64Array にする (経緯度は Float32 だと 1 m 程度しか精度が無い)
 */
export function chunksToBinary(chunks, center, colorShift = 0, opts = {}) {
  const geom = collect(chunks, 'geometry')
  if (!geom) throw new Error('geometry 列が無い')
  const n = geom.length
  const R = collect(chunks, 'Red')
  const G = collect(chunks, 'Green')
  const B = collect(chunks, 'Blue')
  const C = collect(chunks, 'Classification')
  const positions = opts.float64 ? new Float64Array(n * 3) : new Float32Array(n * 3)
  const rgb = new Uint8Array(n * 3)
  const cls = new Uint8Array(n)
  const [cx, cy, cz] = center
  const transform = opts.transform
  let zmin = Infinity, zmax = -Infinity
  for (let i = 0; i < n; i++) {
    const p = geom[i]
    let x = p.x, y = p.y
    if (transform) [x, y] = transform(x, y)
    positions[3 * i] = x - cx
    positions[3 * i + 1] = y - cy
    positions[3 * i + 2] = p.z - cz
    if (p.z < zmin) zmin = p.z
    if (p.z > zmax) zmax = p.z
    if (R && G && B) {
      rgb[3 * i] = R[i] >> colorShift
      rgb[3 * i + 1] = G[i] >> colorShift
      rgb[3 * i + 2] = B[i] >> colorShift
    } else {
      rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = 200
    }
    if (C) cls[i] = C[i]
  }
  return { n, positions, rgb, cls, zmin, zmax }
}

/** 同名の chunk が複数に分かれていても rowStart 順に連結して 1 本の配列にする */
function collect(chunks, name) {
  const parts = chunks.filter(c => c.columnName === name).sort((a, b) => a.rowStart - b.rowStart)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0].columnData
  const out = []
  for (const p of parts) for (let i = 0; i < p.columnData.length; i++) out.push(p.columnData[i])
  return out
}

// ASPRS 標準分類の色 (LAS 1.4 Table 17 の分類コード)
export const CLASS_COLORS = {
  0: [120, 120, 120],   // never classified
  1: [160, 160, 160],   // unclassified
  2: [161, 120, 70],    // ground
  3: [140, 200, 90],    // low vegetation
  4: [90, 180, 60],     // medium vegetation
  5: [40, 140, 40],     // high vegetation
  6: [230, 90, 70],     // building
  7: [255, 0, 255],     // low point (noise)
  9: [60, 120, 230],    // water
  17: [200, 170, 60],   // bridge deck
  18: [255, 0, 255],    // high noise
}

/**
 * 色モードに応じて colors (Uint8Array n*3) を埋める。
 * @param {'rgb'|'elevation'|'class'} mode
 * @param {{n:number, positions:Float32Array, rgb:Uint8Array, cls:Uint8Array}} item
 * @param {{cz:number, zmin:number, zmax:number}} elev 標高の色付け範囲 (絶対標高)
 * @param {Uint8Array} [out] 再利用するバッファ
 */
export function colorize(mode, item, elev, out) {
  const n = item.n
  if (!out || out.length !== n * 3) out = new Uint8Array(n * 3)
  if (mode === 'rgb') {
    out.set(item.rgb)
    return out
  }
  if (mode === 'class') {
    for (let i = 0; i < n; i++) {
      const c = CLASS_COLORS[item.cls[i]] || [255, 255, 255]
      out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2]
    }
    return out
  }
  // elevation
  const span = Math.max(1e-6, elev.zmax - elev.zmin)
  for (let i = 0; i < n; i++) {
    const z = item.positions[3 * i + 2] + elev.cz
    const t = Math.min(1, Math.max(0, (z - elev.zmin) / span))
    const [r, g, b] = ramp(t)
    out[3 * i] = r; out[3 * i + 1] = g; out[3 * i + 2] = b
  }
  return out
}

// 5 段の簡易カラーランプ (青→水色→緑→黄→赤)
const RAMP = [[59, 76, 192], [80, 190, 230], [90, 200, 90], [240, 220, 60], [220, 60, 40]]
function ramp(t) {
  const x = t * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const f = x - i
  const a = RAMP[i], b = RAMP[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** row group の bbox を 12 本の線分 (相対座標) にする。LineLayer 用 */
export function boxEdges(rg, center) {
  const [cx, cy, cz] = center
  const x0 = rg.min[0] - cx, y0 = rg.min[1] - cy, z0 = rg.min[2] - cz
  const x1 = rg.max[0] - cx, y1 = rg.max[1] - cy, z1 = rg.max[2] - cz
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
  return e.map(([a, b]) => ({ rg: rg.index, from: c[a], to: c[b] }))
}
