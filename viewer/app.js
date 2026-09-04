// 点群 GeoParquet ビューア本体。
//  - 概観: 1% サンプル (data/09jc602_geoarrow_overview.parquet) を常に表示
//  - 詳細: 画面内にある本体の row group を、footer の統計 (bbox) で選んで必要な分だけ読む
//  - 描画: deck.gl PointCloudLayer (OrbitView, Z 軸回転)
import { colorize, boxEdges } from './points.js'

const $ = id => document.getElementById(id)
const ui = {
  main: $('main-url'), overview: $('overview-url'), open: $('open'), fit: $('fit'),
  status: $('status'), stats: $('stats'),
  budget: $('budget'), budgetVal: $('budget-val'),
  threshold: $('threshold'), thresholdVal: $('threshold-val'),
  size: $('point-size'), sizeVal: $('point-size-val'),
  boxes: $('show-boxes'), showOverview: $('show-overview'),
  modes: document.querySelectorAll('input[name="mode"]'),
}

const DEBUG = new URLSearchParams(location.search).has('debug')
const dlog = (...a) => { if (DEBUG) console.log(`[app ${(performance.now() / 1000).toFixed(1)}s]`, ...a) }

const state = {
  mainUrl: null, overviewUrl: null,
  summary: null, center: null, elev: null,
  overview: [],            // 概観の item 配列
  detail: new Map(),       // rg index → item (表示中)
  cache: new Map(),        // rg index → item (表示対象外だが保持。挿入順 = LRU)
  desired: new Set(),      // 現在の視点で欲しい rg
  loading: new Map(),      // rg → token
  queue: [],               // 読み込み待ち rg (優先順)
  mode: 'rgb',
  bytes: 0,
  boxData: [],
  boxVersion: 0,
  viewState: null,
  generation: 0,           // Open し直したら増やして古い応答を捨てる
}

// ---------------------------------------------------------------- workers
// 同時に読む row group 数。ブラウザは同一ホストへ 6 接続までしか張らず、
// hyparquet は 1 row group につき列ごとに数本の range request を並列に出すため、
// 6 本並列にすると接続を取り合ってページ全体が固まる (実測)。4 本なら 1M 点 × 8 個が約 10 秒。
const N_WORKERS = +(new URLSearchParams(location.search).get('workers')) || Math.max(2, Math.min(4, navigator.hardwareConcurrency || 4))
let nextId = 1
const activeWorkers = new Map()   // Worker → cancel (reject) 関数

// 1 メッセージ = 1 Worker。応答が来たら terminate する。
// hyparquet は GeoArrow の struct を点ごとの {x,y,z} オブジェクト (中身は boxed double) に展開するので、
// 1M 点の row group を 1 つ読むだけで数百 MB のゴミが出る。Worker 内の V8 はこれをすぐには回収せず
// (実測: 概観 5 row group を読んだ後で Worker 1 本のヒープが 0.7〜1.3 GB、強制 GC で 4 MB に戻る)、
// Worker 4 本分でレンダラープロセスが数 GB に達して Chrome が "Out of Memory" で落ちる。
// Worker を使い捨てにすると isolate ごと消えるのでヒープが確実に OS に返る。
// 代償は Worker 起動と footer の再読み込み (CDN はキャッシュ、footer はローカルで 0.1 秒程度)。
function callWorker(msg) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./worker.js', { type: 'module' })
    activeWorkers.set(w, () => reject(new Error('cancelled')))
    const id = nextId++
    const done = () => { activeWorkers.delete(w); w.terminate() }
    w.onmessage = e => {
      const m = e.data
      if (m.id !== id) return
      dlog('worker message', m.type, m.url?.split('/').pop(), m.rg ?? '', m.n ?? '')
      done()
      if (m.type === 'error') reject(new Error(m.message))
      else resolve(m)
    }
    w.onerror = e => { done(); reject(new Error(e.message || 'worker error')) }
    w.postMessage({ ...msg, id, debug: DEBUG })
  })
}

/** 配列の各要素に非同期関数を並列度 limit で適用する */
async function mapLimited(items, limit, fn) {
  const results = []
  let i = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k) }
  })
  await Promise.all(runners)
  return results
}

// ---------------------------------------------------------------- deck.gl
let deckgl = null
function initDeck() {
  deckgl = new deck.Deck({
    canvas: 'deck-canvas',
    views: new deck.OrbitView({ orbitAxis: 'Z', fovy: 50 }),
    controller: { inertia: 200 },
    viewState: state.viewState,
    onViewStateChange: ({ viewState }) => {
      state.viewState = viewState
      deckgl.setProps({ viewState })
      scheduleUpdate()
      updateStats()
    },
    layers: [],
  })
}

function fitView() {
  const s = state.summary
  const W = window.innerWidth - 360, H = window.innerHeight
  const ex = Math.max(1, s.max[0] - s.min[0]), ey = Math.max(1, s.max[1] - s.min[1])
  const zoom = Math.log2(Math.min(W / ex, H / ey)) - 0.3
  state.viewState = {
    target: [0, 0, 0], zoom, rotationX: 40, rotationOrbit: 25,
    minZoom: zoom - 3, maxZoom: 10,
  }
  if (deckgl) deckgl.setProps({ viewState: state.viewState })
}

function makeItem(r) {
  return { rg: r.rg, n: r.n, positions: r.positions, rgb: r.rgb, cls: r.cls, colors: null, colorsMode: null, data: null }
}

/** deck.gl に渡す data オブジェクト。色モードが変わったときだけ作り直す (毎フレーム再アップロードしないため) */
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
    id,
    coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
    data: layerData(item),
    getNormal: [0, 0, 1],
    material: false,
    pointSize: size,
    sizeUnits: 'pixels',
    pickable: false,
  })
}

function render() {
  if (!deckgl) return
  const size = +ui.size.value
  const layers = []
  if (ui.showOverview.checked) {
    state.overview.forEach((item, i) => layers.push(pointLayer(`overview-${i}`, item, size)))
  }
  for (const [rg, item] of state.detail) layers.push(pointLayer(`rg-${rg}`, item, size))
  if (ui.boxes.checked && state.boxData.length) {
    layers.push(new deck.LineLayer({
      id: 'rg-boxes',
      coordinateSystem: deck.COORDINATE_SYSTEM.CARTESIAN,
      data: state.boxData,
      getSourcePosition: d => d.from,
      getTargetPosition: d => d.to,
      getColor: d => state.detail.has(d.rg) ? [90, 230, 140, 200]
        : state.loading.has(d.rg) || state.desired.has(d.rg) ? [240, 200, 80, 200]
          : [120, 130, 140, 70],
      getWidth: 1,
      widthUnits: 'pixels',
      updateTriggers: { getColor: state.boxVersion },
    }))
  }
  const t0 = performance.now()
  deckgl.setProps({ layers })
  updateStats()
  dlog('render', layers.length, 'layers', (performance.now() - t0).toFixed(0), 'ms')
}

// ---------------------------------------------------------------- 詳細 (row group) の選択
let updateTimer = null
function scheduleUpdate() {
  clearTimeout(updateTimer)
  updateTimer = setTimeout(updateDetail, 200)
}

/** row group の bbox を画面座標に投影した矩形。カメラをまたぐ場合などは null */
function screenBox(rg, vp) {
  const [cx, cy, cz] = state.center
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < 8; i++) {
    const p = vp.project([
      (i & 1 ? rg.max[0] : rg.min[0]) - cx,
      (i & 2 ? rg.max[1] : rg.min[1]) - cy,
      (i & 4 ? rg.max[2] : rg.min[2]) - cz,
    ])
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0])
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1])
  }
  // カメラ面をまたぐと巨大な矩形になる。画面の 20 倍を超えたら捨てる
  if (x1 - x0 > vp.width * 20 || y1 - y0 > vp.height * 20) return null
  return { x0, y0, x1, y1 }
}

function updateDetail() {
  if (!state.summary || !deckgl) return
  const vp = deckgl.getViewports()[0]
  if (!vp) return
  const pxPerM = Math.pow(2, state.viewState.zoom)
  const threshold = +ui.threshold.value
  const budget = +ui.budget.value * 1e6

  const candidates = []
  if (pxPerM >= threshold) {
    const W = vp.width, H = vp.height
    for (const rg of state.summary.rgs) {
      const b = screenBox(rg, vp)
      if (!b) continue
      if (b.x1 < 0 || b.y1 < 0 || b.x0 > W || b.y0 > H) continue
      const dx = (b.x0 + b.x1) / 2 - W / 2
      const dy = (b.y0 + b.y1) / 2 - H / 2
      candidates.push({ rg: rg.index, d: dx * dx + dy * dy, rows: rg.rows })
    }
    candidates.sort((a, b) => a.d - b.d)
  }
  const desired = new Set()
  let total = 0
  for (const c of candidates) {
    if (total + c.rows > budget) break
    desired.add(c.rg)
    total += c.rows
  }
  state.desired = desired

  // 表示中で不要になったものはキャッシュへ
  for (const [rg, item] of [...state.detail]) {
    if (!desired.has(rg)) { state.detail.delete(rg); putCache(rg, item) }
  }
  // 欲しいものがキャッシュにあれば戻す、無ければ読み込みキューへ
  state.queue = []
  for (const c of candidates) {
    if (!desired.has(c.rg) || state.detail.has(c.rg)) continue
    if (state.cache.has(c.rg)) {
      const item = state.cache.get(c.rg)
      state.cache.delete(c.rg)
      state.detail.set(c.rg, item)
    } else if (!state.loading.has(c.rg)) {
      state.queue.push(c.rg)
    }
  }
  state.boxVersion++
  pump()
  render()
}

function putCache(rg, item) {
  state.cache.delete(rg)
  state.cache.set(rg, item)
  const limit = +ui.budget.value * 1e6 * 1.5
  let total = 0
  for (const it of state.cache.values()) total += it.n
  for (const [k, it] of state.cache) {
    if (total <= limit) break
    state.cache.delete(k)
    total -= it.n
  }
}

function pump() {
  while (state.loading.size < N_WORKERS && state.queue.length) {
    const rg = state.queue.shift()
    if (state.detail.has(rg) || state.loading.has(rg)) continue
    requestRg(rg)
  }
}

async function requestRg(rg) {
  const gen = state.generation
  const token = {}
  state.loading.set(rg, token)
  dlog('request rg', rg)
  try {
    const r = await callWorker({ type: 'load', url: state.mainUrl, rg, center: state.center })
    if (gen !== state.generation) return
    state.loading.delete(rg)
    dlog('loaded rg', rg, 'n', r.n)
    state.bytes += r.bytes
    const item = makeItem(r)
    if (state.desired.has(rg)) state.detail.set(rg, item)
    else putCache(rg, item)
    state.boxVersion++
    setStatus(`row group ${rg}: ${(r.n / 1e6).toFixed(2)} M 点を ${(r.ms / 1000).toFixed(1)} 秒で読み込み`)
  } catch (err) {
    if (gen !== state.generation) return
    state.loading.delete(rg)
    setStatus(`row group ${rg} の読み込みに失敗: ${err.message}`, true)
  }
  pump()
  render()
}

// ---------------------------------------------------------------- open
function reset() {
  state.generation++
  state.summary = null; state.center = null; state.elev = null
  state.overview = []; state.detail.clear(); state.cache.clear()
  state.desired.clear(); state.loading.clear(); state.queue = []
  state.bytes = 0; state.boxData = []
  for (const [w, cancel] of activeWorkers) { w.terminate(); cancel() }   // 読み込み中の Worker は捨てる (帯域とメモリを返す)
  activeWorkers.clear()
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
    state.center = summary.center
    state.elev = { cz: summary.center[2], zmin: summary.min[2], zmax: summary.max[2] }
    state.boxData = summary.rgs.flatMap(rg => boxEdges(rg, summary.center))
    fitView()
    if (!deckgl) initDeck()
    render()
    const crs = summary.geo?.columns?.geometry?.crs?.id
    setStatus(`${summary.rows.toLocaleString()} 点 / ${summary.rgs.length} row group` +
      (crs ? ` / CRS ${crs.authority}:${crs.code}` : ''))

    if (state.overviewUrl) {
      try {
        const r = await callWorker({ type: 'open', url: state.overviewUrl })
        if (gen !== state.generation) return
        await mapLimited(r.summary.rgs, N_WORKERS, async rg => {
          const res = await callWorker({ type: 'load', url: state.overviewUrl, rg: rg.index, center: state.center })
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
    if (gen !== state.generation) return   // Open し直しで捨てられた古い呼び出し
    setStatus(`開けません: ${err.message}`, true)
  } finally {
    if (gen === state.generation) ui.open.disabled = false
  }
}

// ---------------------------------------------------------------- UI
function setStatus(text, isError = false) {
  ui.status.textContent = text
  ui.status.classList.toggle('error', isError)
}

function updateStats() {
  if (!state.summary) { ui.stats.textContent = ''; return }
  let shown = 0
  if (ui.showOverview.checked) for (const it of state.overview) shown += it.n
  for (const it of state.detail.values()) shown += it.n
  const pxPerM = state.viewState ? Math.pow(2, state.viewState.zoom) : 0
  ui.stats.innerHTML = [
    ['表示点数', `${(shown / 1e6).toFixed(2)} M`],
    ['詳細 row group', `${state.detail.size} 表示 / ${state.loading.size} 読込中 / ${state.cache.size} 保持`],
    ['ダウンロード', `${(state.bytes / 1e6).toFixed(0)} MB`],
    ['解像度', `${pxPerM.toFixed(2)} px/m`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')
}

function bindSlider(input, label, fmt, onChange) {
  const sync = () => { label.textContent = fmt(+input.value); onChange() }
  input.addEventListener('input', sync)
  label.textContent = fmt(+input.value)
}
bindSlider(ui.budget, ui.budgetVal, v => `${v} M 点`, scheduleUpdate)
bindSlider(ui.threshold, ui.thresholdVal, v => `${v.toFixed(2)} px/m`, scheduleUpdate)
bindSlider(ui.size, ui.sizeVal, v => `${v.toFixed(1)} px`, render)
ui.boxes.addEventListener('change', render)
ui.showOverview.addEventListener('change', render)
ui.modes.forEach(r => r.addEventListener('change', () => { state.mode = r.value; render() }))
ui.open.addEventListener('click', openFiles)
ui.fit.addEventListener('click', () => { if (state.summary) { fitView(); scheduleUpdate() } })
window.addEventListener('resize', scheduleUpdate)

// 自動テスト用フック (puppeteer から視点を操作して読み込みを確認する)
window.viewerDebug = {
  get deck() { return deckgl },
  getViewport: () => deckgl.getViewports()[0],
  state,
  setViewState(vs) {
    state.viewState = { ...state.viewState, ...vs }
    deckgl.setProps({ viewState: state.viewState })
    scheduleUpdate()
  },
  counts: () => ({
    overview: state.overview.reduce((a, it) => a + it.n, 0),
    detail: state.detail.size, loading: state.loading.size, queue: state.queue.length,
    detailPoints: [...state.detail.values()].reduce((a, it) => a + it.n, 0), bytes: state.bytes,
  }),
}

if (!new URLSearchParams(location.search).has('noauto')) openFiles()
