// 点群 GeoParquet を MapLibre の地図に重ねるビューア。
//  - 読み取り: index.html 版と同じ worker.js (hyparquet で row group を部分読み)。Worker 内で proj4 により
//    平面直角座標 → 経緯度に変換し、Float64 の [経度, 緯度, 標高] で受け取る
//  - 描画: deck.gl MapboxOverlay (LNGLAT 座標系の PointCloudLayer) を MapLibre のコントロールとして載せる
//  - 詳細 row group の選択: footer の bbox を経緯度にして map.project で画面矩形にし、画面内で中心に近いものから読む
//  - 背景: 地理院タイル (ラスタ)
import { colorize } from './points.js'
import proj4 from 'https://cdn.jsdelivr.net/npm/proj4@2.15.0/+esm'

const $ = id => document.getElementById(id)
const ui = {
  main: $('main-url'), overview: $('overview-url'), open: $('open'), fit: $('fit'),
  status: $('status'), stats: $('stats'),
  basemap: $('basemap'), basemapOpacity: $('basemap-opacity'), basemapOpacityVal: $('basemap-opacity-val'),
  budget: $('budget'), budgetVal: $('budget-val'),
  threshold: $('threshold'), thresholdVal: $('threshold-val'),
  size: $('point-size'), sizeVal: $('point-size-val'),
  boxes: $('show-boxes'), showOverview: $('show-overview'),
  modes: document.querySelectorAll('input[name="mode"]'),
}
const params = new URLSearchParams(location.search)
const DEBUG = params.has('debug')
const dlog = (...a) => { if (DEBUG) console.log(`[maplibre ${(performance.now() / 1000).toFixed(1)}s]`, ...a) }

// ---------------------------------------------------------------- CRS
// 平面直角座標系 (JGD2011) I〜XIX = EPSG:6669〜6687。GeoParquet の geo メタデータの EPSG コードから proj4 文字列を作る
const JPRCS = {
  6669: [33, 129.5], 6670: [33, 131], 6671: [36, 132.1666666666667], 6672: [33, 133.5], 6673: [36, 134.3333333333333],
  6674: [36, 136], 6675: [36, 137.1666666666667], 6676: [36, 138.5], 6677: [36, 139.8333333333333], 6678: [40, 140.8333333333333],
  6679: [44, 140.25], 6680: [44, 142.25], 6681: [44, 144.25], 6682: [26, 142], 6683: [26, 127.5], 6684: [26, 124],
  6685: [26, 131], 6686: [20, 136], 6687: [26, 154],
}
function projFromGeo(geo) {
  if (params.get('proj')) return params.get('proj')
  const id = geo?.columns?.[geo.primary_column ?? 'geometry']?.crs?.id
  if (id?.authority === 'EPSG' && JPRCS[id.code]) {
    const [lat0, lon0] = JPRCS[id.code]
    return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`
  }
  if (id?.authority === 'EPSG' && id.code === 4326) return null   // 既に経緯度
  throw new Error(`CRS を判定できない (${id ? `${id.authority}:${id.code}` : 'geo メタデータ無し'})。?proj= で proj4 文字列を指定してください`)
}

// ---------------------------------------------------------------- state
const state = {
  mainUrl: null, overviewUrl: null,
  summary: null, proj: null, toLngLat: null, elev: null,
  rgs: [],                 // 本体 row group: { index, rows, rowStart, rowEnd, bytes, ll: [[lng0, lat0], [lng1, lat1]], zmax }
  bounds: null,            // 全体の経緯度範囲 [[lng0, lat0], [lng1, lat1]]
  overview: [],
  detail: new Map(), cache: new Map(), desired: new Set(), loading: new Map(), queue: [],
  mode: 'rgb', bytes: 0, boxData: [], boxVersion: 0, generation: 0,
}

// ---------------------------------------------------------------- workers (index.html 版と同じ使い捨て方式)
const N_WORKERS = +params.get('workers') || Math.max(2, Math.min(4, navigator.hardwareConcurrency || 4))
let nextId = 1
const activeWorkers = new Map()
function callWorker(msg) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./worker.js', { type: 'module' })
    activeWorkers.set(w, () => reject(new Error('cancelled')))
    const id = nextId++
    const done = () => { activeWorkers.delete(w); w.terminate() }
    w.onmessage = e => {
      const m = e.data
      if (m.id !== id) return
      done()
      if (m.type === 'error') reject(new Error(m.message))
      else resolve(m)
    }
    w.onerror = e => { done(); reject(new Error(e.message || 'worker error')) }
    w.postMessage({ ...msg, id, debug: DEBUG })
  })
}
async function mapLimited(items, limit, fn) {
  const results = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k) }
  }))
  return results
}
/** 本体・概観とも同じ引数で読む。経緯度 (Float64) で受け取る */
function loadRg(url, rg) {
  return callWorker({ type: 'load', url, rg, center: [0, 0, 0], proj: state.proj, float64: true })
}

// ---------------------------------------------------------------- map
const GSI = {
  pale: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', 18],
  std: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', 18],
  photo: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', 18],
  hillshade: ['https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png', 16],
}
function styleFor(kind) {
  const style = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0e11' } }] }
  if (GSI[kind]) {
    const [url, maxzoom] = GSI[kind]
    style.sources.gsi = { type: 'raster', tiles: [url], tileSize: 256, maxzoom, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' }
    style.layers.push({ id: 'gsi', type: 'raster', source: 'gsi', paint: { 'raster-opacity': +ui.basemapOpacity.value } })
  }
  return style
}
const map = new maplibregl.Map({
  container: 'map', style: styleFor(ui.basemap.value),
  center: [139.0, 36.1], zoom: 11, maxPitch: 85, attributionControl: { compact: false },
})
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }))
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }))
const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] })
map.addControl(overlay)
map.on('moveend', () => { scheduleUpdate(); updateStats() })
map.on('move', updateStats)
ui.basemap.addEventListener('change', () => map.setStyle(styleFor(ui.basemap.value)))

// ---------------------------------------------------------------- deck layers
function makeItem(r) {
  return { rg: r.rg, n: r.n, positions: r.positions, rgb: r.rgb, cls: r.cls, colors: null, colorsMode: null, data: null }
}
function layerData(item) {
  if (!item.data || item.colorsMode !== state.mode) {
    item.colors = colorize(state.mode, item, state.elev, item.colors)
    item.colorsMode = state.mode
    item.data = {
      length: item.n,
      attributes: {
        getPosition: { value: item.positions, size: 3 },
        getColor: { value: item.colors, size: 3, normalized: true },
      },
    }
  }
  return item.data
}
function pointLayer(id, item, size) {
  return new deck.PointCloudLayer({
    id, data: layerData(item),
    coordinateSystem: deck.COORDINATE_SYSTEM.LNGLAT,
    getNormal: [0, 0, 1], material: false,
    pointSize: size, sizeUnits: 'pixels', pickable: false,
  })
}
function render() {
  const size = +ui.size.value
  const layers = []
  if (ui.showOverview.checked) state.overview.forEach((item, i) => layers.push(pointLayer(`overview-${i}`, item, size)))
  for (const [rg, item] of state.detail) layers.push(pointLayer(`rg-${rg}`, item, size))
  if (ui.boxes.checked && state.boxData.length) {
    layers.push(new deck.LineLayer({
      id: 'rg-boxes', data: state.boxData,
      coordinateSystem: deck.COORDINATE_SYSTEM.LNGLAT,
      getSourcePosition: d => d.from, getTargetPosition: d => d.to,
      getColor: d => state.detail.has(d.rg) ? [90, 230, 140, 220]
        : state.loading.has(d.rg) || state.desired.has(d.rg) ? [240, 200, 80, 220]
          : [120, 130, 140, 90],
      getWidth: 1, widthUnits: 'pixels',
      updateTriggers: { getColor: state.boxVersion },
    }))
  }
  overlay.setProps({ layers })
  updateStats()
}

// ---------------------------------------------------------------- 詳細 (row group) の選択
let updateTimer = null
function scheduleUpdate() { clearTimeout(updateTimer); updateTimer = setTimeout(updateDetail, 200) }

/** 現在のズーム・緯度での画面解像度 (px/m) */
function pxPerMeter() {
  const lat = map.getCenter().lat * Math.PI / 180
  return Math.pow(2, map.getZoom()) / (156543.03392 * Math.cos(lat))
}
/** row group の経緯度 bbox を画面矩形にする。画面外なら null */
function screenBox(rg) {
  const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < 4; i++) {
    const p = map.project([i & 1 ? rg.ll[1][0] : rg.ll[0][0], i & 2 ? rg.ll[1][1] : rg.ll[0][1]])
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
  }
  if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) return null
  return { x0, y0, x1, y1, W, H }
}
function updateDetail() {
  if (!state.summary) return
  const threshold = +ui.threshold.value
  const budget = +ui.budget.value * 1e6
  const candidates = []
  if (pxPerMeter() >= threshold) {
    for (const rg of state.rgs) {
      const b = screenBox(rg)
      if (!b) continue
      const dx = (b.x0 + b.x1) / 2 - b.W / 2, dy = (b.y0 + b.y1) / 2 - b.H / 2
      candidates.push({ rg: rg.index, d: dx * dx + dy * dy, rows: rg.rows })
    }
    candidates.sort((a, b) => a.d - b.d)
  }
  const desired = new Set()
  let total = 0
  for (const c of candidates) {
    if (total + c.rows > budget) break
    desired.add(c.rg); total += c.rows
  }
  state.desired = desired
  for (const [rg, item] of [...state.detail]) if (!desired.has(rg)) { state.detail.delete(rg); putCache(rg, item) }
  state.queue = []
  for (const c of candidates) {
    if (!desired.has(c.rg) || state.detail.has(c.rg)) continue
    if (state.cache.has(c.rg)) { state.detail.set(c.rg, state.cache.get(c.rg)); state.cache.delete(c.rg) }
    else if (!state.loading.has(c.rg)) state.queue.push(c.rg)
  }
  state.boxVersion++
  pump(); render()
}
function putCache(rg, item) {
  state.cache.delete(rg); state.cache.set(rg, item)
  const limit = +ui.budget.value * 1e6 * 1.5
  let total = 0
  for (const it of state.cache.values()) total += it.n
  for (const [k, it] of state.cache) { if (total <= limit) break; state.cache.delete(k); total -= it.n }
}
function pump() {
  while (state.loading.size < N_WORKERS && state.queue.length) {
    const rg = state.queue.shift()
    if (!state.detail.has(rg) && !state.loading.has(rg)) requestRg(rg)
  }
}
async function requestRg(rg) {
  const gen = state.generation
  state.loading.set(rg, {})
  try {
    const r = await loadRg(state.mainUrl, rg)
    if (gen !== state.generation) return
    state.loading.delete(rg)
    state.bytes += r.bytes
    const item = makeItem(r)
    if (state.desired.has(rg)) state.detail.set(rg, item); else putCache(rg, item)
    state.boxVersion++
    setStatus(`row group ${rg}: ${(r.n / 1e6).toFixed(2)} M 点を ${(r.ms / 1000).toFixed(1)} 秒で読み込み (経緯度変換込み)`)
  } catch (err) {
    if (gen !== state.generation) return
    state.loading.delete(rg)
    setStatus(`row group ${rg} の読み込みに失敗: ${err.message}`, true)
  }
  pump(); render()
}

// ---------------------------------------------------------------- open
function reset() {
  state.generation++
  state.summary = null; state.proj = null; state.toLngLat = null; state.elev = null
  state.rgs = []; state.bounds = null; state.overview = []
  state.detail.clear(); state.cache.clear(); state.desired.clear(); state.loading.clear(); state.queue = []
  state.bytes = 0; state.boxData = []
  for (const [w, cancel] of activeWorkers) { w.terminate(); cancel() }
  activeWorkers.clear()
  render()
}
function fitView() {
  if (state.bounds) map.fitBounds(state.bounds, { padding: 20, duration: 0, pitch: 0, bearing: 0 })
}
async function openFiles() {
  reset()
  const gen = state.generation
  state.mainUrl = new URL(ui.main.value.trim(), location.href).href
  state.overviewUrl = ui.overview.value.trim() ? new URL(ui.overview.value.trim(), location.href).href : null
  ui.open.disabled = true
  try {
    setStatus('footer を読み込み中…')
    const { summary } = await callWorker({ type: 'open', url: state.mainUrl })
    if (gen !== state.generation) return
    state.summary = summary
    state.proj = projFromGeo(summary.geo)
    state.toLngLat = state.proj ? (x, y) => proj4(state.proj, 'EPSG:4326').forward([x, y]) : (x, y) => [x, y]
    state.elev = { cz: 0, zmin: summary.min[2], zmax: summary.max[2] }
    // row group の bbox を経緯度に (4 隅を変換して外接矩形を取る。tmerc の歪みは 2 km 程度なら無視できる)
    state.rgs = summary.rgs.map(rg => {
      const c = [[rg.min[0], rg.min[1]], [rg.max[0], rg.min[1]], [rg.min[0], rg.max[1]], [rg.max[0], rg.max[1]]].map(([x, y]) => state.toLngLat(x, y))
      const lng = c.map(p => p[0]), lat = c.map(p => p[1])
      return { ...rg, ll: [[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]], zmax: rg.max[2] }
    })
    const allLng = state.rgs.flatMap(r => [r.ll[0][0], r.ll[1][0]]), allLat = state.rgs.flatMap(r => [r.ll[0][1], r.ll[1][1]])
    state.bounds = [[Math.min(...allLng), Math.min(...allLat)], [Math.max(...allLng), Math.max(...allLat)]]
    state.boxData = state.rgs.flatMap(rg => {
      const [[a, b], [c, d]] = rg.ll, z = rg.zmax
      const p = [[a, b, z], [c, b, z], [c, d, z], [a, d, z]]
      return [0, 1, 2, 3].map(i => ({ rg: rg.index, from: p[i], to: p[(i + 1) % 4] }))
    })
    fitView()
    render()
    const crs = summary.geo?.columns?.geometry?.crs?.id
    setStatus(`${summary.rows.toLocaleString()} 点 / ${summary.rgs.length} row group` + (crs ? ` / CRS ${crs.authority}:${crs.code} → WGS84` : ''))

    if (state.overviewUrl) {
      try {
        const r = await callWorker({ type: 'open', url: state.overviewUrl })
        if (gen !== state.generation) return
        await mapLimited(r.summary.rgs, N_WORKERS, async rg => {
          const res = await loadRg(state.overviewUrl, rg.index)
          if (gen !== state.generation) return
          state.overview.push(makeItem(res))
          state.bytes += res.bytes
          render()
        })
      } catch (err) {
        setStatus(`概観ファイルを開けないので本体の row group だけで表示します (${err.message})`, true)
      }
    }
    scheduleUpdate()
  } catch (err) {
    if (gen !== state.generation) return
    setStatus(`開けません: ${err.message}`, true)
  } finally {
    if (gen === state.generation) ui.open.disabled = false
  }
}

// ---------------------------------------------------------------- UI
function setStatus(text, isError = false) { ui.status.textContent = text; ui.status.classList.toggle('error', isError) }
function updateStats() {
  if (!state.summary) { ui.stats.textContent = ''; return }
  let shown = 0
  if (ui.showOverview.checked) for (const it of state.overview) shown += it.n
  for (const it of state.detail.values()) shown += it.n
  const c = map.getCenter()
  ui.stats.innerHTML = [
    ['表示点数', `${(shown / 1e6).toFixed(2)} M`],
    ['詳細 row group', `${state.detail.size} 表示 / ${state.loading.size} 読込中 / ${state.cache.size} 保持`],
    ['ダウンロード', `${(state.bytes / 1e6).toFixed(0)} MB`],
    ['解像度', `${pxPerMeter().toFixed(2)} px/m (zoom ${map.getZoom().toFixed(1)})`],
    ['中心', `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')
}
function bindSlider(input, label, fmt, onChange) {
  input.addEventListener('input', () => { label.textContent = fmt(+input.value); onChange() })
  label.textContent = fmt(+input.value)
}
bindSlider(ui.budget, ui.budgetVal, v => `${v} M 点`, scheduleUpdate)
bindSlider(ui.threshold, ui.thresholdVal, v => `${v.toFixed(2)} px/m`, scheduleUpdate)
bindSlider(ui.size, ui.sizeVal, v => `${v.toFixed(1)} px`, render)
bindSlider(ui.basemapOpacity, ui.basemapOpacityVal, v => `${Math.round(v * 100)} %`, () => {
  if (map.getLayer('gsi')) map.setPaintProperty('gsi', 'raster-opacity', +ui.basemapOpacity.value)
})
ui.boxes.addEventListener('change', render)
ui.showOverview.addEventListener('change', render)
ui.modes.forEach(r => r.addEventListener('change', () => { state.mode = r.value; render() }))
ui.open.addEventListener('click', openFiles)
ui.fit.addEventListener('click', () => { fitView(); scheduleUpdate() })

// 自動テスト用フック
window.viewerDebug = {
  map, overlay, state,
  jumpTo: opts => { map.jumpTo(opts); scheduleUpdate() },
  counts: () => ({
    overview: state.overview.reduce((a, it) => a + it.n, 0),
    detail: state.detail.size, loading: state.loading.size, queue: state.queue.length,
    detailPoints: [...state.detail.values()].reduce((a, it) => a + it.n, 0), bytes: state.bytes,
  }),
}

map.once('load', () => { if (!params.has('noauto')) openFiles() })
