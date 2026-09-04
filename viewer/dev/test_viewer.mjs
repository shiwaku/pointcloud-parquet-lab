// ビューアの動作確認 (puppeteer-core + headless Chrome)。
//   npm i puppeteer-core            (任意のディレクトリで。node_modules はリポジトリに含めない)
//   python viewer/serve.py          (別ターミナルで起動しておく)
//   node viewer/dev/test_viewer.mjs
// 環境変数: CHROME (chrome.exe のパス), BASE (既定 http://127.0.0.1:8080), OUT (スクリーンショット出力先)
// 注意:
//   - --use-angle=d3d11 を付けないと headless はソフトウェア GL になり、数百万点の描画で固まる
//   - waitForFunction は polling を数値で指定する (既定の rAF ポーリングは headless で止まることがある)
//   - 途中で失敗したら headless Chrome が残るので、次回実行前に終了させること
import puppeteer from 'puppeteer-core'
import path from 'node:path'
const OUT = (process.env.OUT || path.join(import.meta.dirname, 'out')) + '/'
import('node:fs').then(fs => fs.mkdirSync(OUT, { recursive: true }))
const BASE = process.env.BASE || 'http://127.0.0.1:8080'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 600_000,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1200,800', `--user-data-dir=${process.env.TEMP || '/tmp'}/geoparquet-viewer-test-profile`],
  defaultViewport: { width: 1200, height: 800 },
})
const page = await browser.newPage()
const logs = []
page.on('console', m => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') console.log('[console error]', m.text()) })
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))
page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))
process.on('uncaughtException', e => { console.log('FAILED', e.message); console.log('--- console'); for (const l of logs.slice(0, 30)) console.log(l); process.exit(1) })
const t0 = Date.now()
await page.goto(BASE + '/viewer/', { waitUntil: 'load' })
const counts = () => page.evaluate(() => window.viewerDebug?.counts())
const status = () => page.evaluate(() => document.getElementById('status').textContent)
await page.waitForFunction(() => window.viewerDebug && window.viewerDebug.counts().overview > 2_400_000, { timeout: 90_000, polling: 500 })
console.log('overview loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's', await counts(), '|', await status())
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: OUT + 'test_overview.png' })

// ズームイン: 全体表示の zoom + 3 (8 倍) で、中心から少しずらした地点を見る
const vs = await page.evaluate(() => window.viewerDebug.state.viewState)
console.log('viewState', vs)
const t1 = Date.now()
await page.evaluate(z => window.viewerDebug.setViewState({ zoom: z, target: [150, -100, 0], rotationX: 35 }), vs.zoom + 3)
await page.waitForFunction(() => { const c = window.viewerDebug.counts(); return c.detail > 0 && c.loading === 0 && c.queue === 0 }, { timeout: 180_000, polling: 500 })
console.log('detail loaded in', ((Date.now() - t1) / 1000).toFixed(1), 's', await counts(), '|', await status())
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: OUT + 'test_detail_rgb.png' })

await page.evaluate(() => document.querySelector('input[name="mode"][value="elevation"]').click())
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: OUT + 'test_detail_elev.png' })
await page.evaluate(() => document.querySelector('input[name="mode"][value="class"]').click())
await page.click('#show-boxes')
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: OUT + 'test_detail_class.png' })

// さらにズームして別の場所へ移動 → キャッシュ/入れ替えの動作
const t2 = Date.now()
await page.evaluate(z => window.viewerDebug.setViewState({ zoom: z, target: [-500, 300, 0] }), vs.zoom + 4)
await page.waitForFunction(() => { const c = window.viewerDebug.counts(); return c.loading === 0 && c.queue === 0 }, { timeout: 180_000, polling: 500 })
await new Promise(r => setTimeout(r, 500))
console.log('moved in', ((Date.now() - t2) / 1000).toFixed(1), 's', await counts(), 'cache', await page.evaluate(() => window.viewerDebug.state.cache.size))
await page.screenshot({ path: OUT + 'test_moved.png' })

console.log('--- console (' + logs.length + ')'); for (const l of logs.slice(0, 30)) console.log(l)
await browser.close()
