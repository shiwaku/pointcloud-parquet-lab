// MapLibre 版ビューア (viewer/maplibre.html) の動作確認 (puppeteer-core + headless Chrome)。
//   npm i puppeteer-core            (任意のディレクトリで)
//   python viewer/serve.py          (別ターミナルで起動しておく)
//   node viewer/dev/test_maplibre.mjs
// 環境変数: CHROME (chrome.exe のパス), BASE (既定 http://127.0.0.1:8080), OUT (スクリーンショット出力先)
// 地理院タイルを読むのでインターネット接続が必要。
import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'
const OUT = (process.env.OUT || path.join(import.meta.dirname, 'out')) + '/'
fs.mkdirSync(OUT, { recursive: true })
const BASE = process.env.BASE || 'http://127.0.0.1:8080'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 600_000,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900', `--user-data-dir=${process.env.TEMP || '/tmp'}/maplibre-viewer-test-profile`],
  defaultViewport: { width: 1400, height: 900 },
})
const page = await browser.newPage()
const logs = []
page.on('console', m => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') console.log('[console error]', m.text().slice(0, 300)) })
page.on('pageerror', e => { logs.push(`[pageerror] ${e.message}`); console.log('[pageerror]', e.message) })
page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))
const counts = () => page.evaluate(() => window.viewerDebug?.counts())
const status = () => page.evaluate(() => document.getElementById('status').textContent)
const settle = ms => new Promise(r => setTimeout(r, ms))
try {
  const t0 = Date.now()
  await page.goto(BASE + '/viewer/maplibre.html', { waitUntil: 'load' })
  await page.waitForFunction(() => window.viewerDebug && window.viewerDebug.counts().overview > 2_400_000, { timeout: 120_000, polling: 500 })
  console.log('overview loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's', await counts(), '|', await status())
  const bounds = await page.evaluate(() => window.viewerDebug.state.bounds)
  console.log('bounds (lng/lat)', JSON.stringify(bounds))
  await settle(4000)   // タイルの読み込み待ち
  await page.screenshot({ path: OUT + 'maplibre_overview.png' })

  // 標高色 + 陰影起伏図で位置合わせを目視確認できるようにする
  await page.evaluate(() => document.querySelector('input[name="mode"][value="elevation"]').click())
  await page.select('#basemap', 'hillshade')
  await settle(4000)
  await page.screenshot({ path: OUT + 'maplibre_overview_elev_hillshade.png' })

  // 中心付近にズームして詳細 row group を読む
  const center = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
  const t1 = Date.now()
  await page.evaluate(c => window.viewerDebug.jumpTo({ center: c, zoom: 16.5, pitch: 55, bearing: 20 }), center)
  await page.waitForFunction(() => { const c = window.viewerDebug.counts(); return c.detail > 0 && c.loading === 0 && c.queue === 0 }, { timeout: 240_000, polling: 500 })
  console.log('detail loaded in', ((Date.now() - t1) / 1000).toFixed(1), 's', await counts(), '|', await status())
  await page.select('#basemap', 'photo')
  await page.evaluate(() => document.querySelector('input[name="mode"][value="rgb"]').click())
  await settle(4000)
  await page.screenshot({ path: OUT + 'maplibre_detail_rgb.png' })
  await page.evaluate(() => document.querySelector('input[name="mode"][value="class"]').click())
  await settle(1500)
  await page.screenshot({ path: OUT + 'maplibre_detail_class.png' })

  // 別の場所へ移動: キャッシュと入れ替え
  const t2 = Date.now()
  await page.evaluate(c => window.viewerDebug.jumpTo({ center: [c[0] + 0.006, c[1] - 0.003], zoom: 17, pitch: 60 }), center)
  await settle(500)   // updateDetail は 200 ms デバウンスなので、読み込みが始まるまで待つ
  await page.waitForFunction(() => { const c = window.viewerDebug.counts(); return c.loading === 0 && c.queue === 0 }, { timeout: 240_000, polling: 500 })
  console.log('moved in', ((Date.now() - t2) / 1000).toFixed(1), 's', await counts(), 'cache', await page.evaluate(() => window.viewerDebug.state.cache.size))
  await settle(3000)
  await page.screenshot({ path: OUT + 'maplibre_moved.png' })

  const bad = logs.filter(l => /^\[(error|pageerror|requestfailed)\]/.test(l))
  console.log('--- console errors (' + bad.length + ')'); for (const l of bad.slice(0, 20)) console.log(l.slice(0, 300))
  console.log(bad.length ? 'DONE WITH ERRORS' : 'OK')
} catch (e) {
  console.log('FAILED', e.message); console.log('--- console'); for (const l of logs.slice(0, 40)) console.log(l.slice(0, 300))
  await page.screenshot({ path: OUT + 'maplibre_failed.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
