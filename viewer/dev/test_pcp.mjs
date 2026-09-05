// PCP (kanahiro.github.io/pcp) で自作の PCP ファイルが開けるかの動作確認 (puppeteer-core + headless Chrome)。
//   npm i puppeteer-core            (任意のディレクトリで。node_modules はリポジトリに含めない)
//   node viewer/dev/test_pcp.mjs https://shi-works.com/geoparquet/pcp/09jc602_pcp_test.parquet
// 環境変数: CHROME (chrome.exe のパス), OUT (スクリーンショット出力先)
// 注意:
//   - http://127.0.0.1 のファイルを開くときは Chrome の Local Network Access 制限を切る必要がある
//     (--disable-features=LocalNetworkAccessChecks,... を付けている。R2 など公開 URL では不要)
//   - ビューアは既定データ (cogp-demo) の読み込み中に Open を押しても無視するので、完了を待ってから URL を差し替える
//   - メタデータが検証で落ちると画面に "Invalid point_cloud metadata" と出るだけなので、本文テキストで判定する
//   - Parquet への range request は Worker が出すので page の response イベントには来ない。転送量はビューアの表示を読む
import puppeteer from 'puppeteer-core'
import path from 'node:path'
import fs from 'node:fs'
const URL = process.argv[2] || 'https://shi-works.com/geoparquet/pcp/09jc602_pcp_test.parquet'
const OUT = (process.env.OUT || path.join(import.meta.dirname, 'out')) + '/'
fs.mkdirSync(OUT, { recursive: true })
const name = path.basename(URL, '.parquet')
const ERROR_RE = /Invalid point_cloud metadata|missing the point_cloud key|Failed to [^\n]*|Row Group is missing[^\n]*/
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 600_000,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1400,900',
    '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,PrivateNetworkAccessSendPreflights',
    `--user-data-dir=${process.env.TEMP || '/tmp'}/pcp-test-profile`],
  defaultViewport: { width: 1400, height: 900 },
})
const page = await browser.newPage()
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))
const text = () => page.evaluate(() => document.body.innerText)
const telemetry = async () => {
  const t = await text()
  const pick = re => t.match(re)?.[1]
  return {
    points: pick(/([\d,]+)\nPoints drawn/), transferred: pick(/([\d.]+ [kM]?B)\nTransferred/), rangeRequests: pick(/(\d+)\nRange requests/),
    rowGroups: pick(/(\d+ \/ \d+)\nRow Groups read/), levels: pick(/(\d+ levels)/), voxel: pick(/(×\d+ voxel)/), footer: pick(/([\d.]+ [kM]B footer)/),
    lod: pick(/(L\d+ \d+\/\d+(?: · L\d+ \d+\/\d+)*)/), error: t.match(ERROR_RE)?.[0],
  }
}
try {
  await page.goto('https://kanahiro.github.io/pcp/', { waitUntil: 'load' })
  await page.waitForFunction(() => /points ready/.test(document.body.innerText), { timeout: 120_000, polling: 500 })
  const before = await telemetry()
  console.log('default data ready:', JSON.stringify(before))

  const t0 = Date.now()
  await page.evaluate(u => { const i = document.getElementById('url'); i.value = u; i.dispatchEvent(new Event('input', { bubbles: true })) }, URL)
  await page.click('#open')
  // 「Row Groups read」の分母 (全 row group 数) が既定データから変わる、またはエラー文が出るまで待つ
  await page.waitForFunction((prev, errSrc) => {
    const t = document.body.innerText
    if (new RegExp(errSrc).test(t)) return true
    const rg = t.match(/(\d+ \/ \d+)\nRow Groups read/)?.[1]
    return rg && rg.split(' / ')[1] !== prev.split(' / ')[1] && /points ready/.test(t)
  }, { timeout: 180_000, polling: 500 }, before.rowGroups, ERROR_RE.source)
  await new Promise(r => setTimeout(r, 3000))   // 描画が落ち着くまで
  const tel = await telemetry()
  console.log(`opened ${URL} in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(tel))
  await page.screenshot({ path: OUT + `pcp_${name}.png` })
  if (!tel.error) {
    await page.evaluate(() => document.querySelector('input[name="color"][value="resolution"]').click())
    await new Promise(r => setTimeout(r, 1500))
    await page.screenshot({ path: OUT + `pcp_${name}_lod.png` })
  }
  const bad = logs.filter(l => /^\[(error|pageerror)\]/.test(l) && !/404/.test(l))   // 404 はビューア自身の favicon
  console.log('--- console errors (' + bad.length + ')'); for (const l of bad.slice(0, 20)) console.log(l)
  if (tel.error) { console.log('FAILED:', tel.error); process.exitCode = 1 } else console.log('OK')
} catch (e) {
  console.log('FAILED', e.message); console.log('--- console'); for (const l of logs.slice(0, 30)) console.log(l)
  await page.screenshot({ path: OUT + `pcp_${name}_failed.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
