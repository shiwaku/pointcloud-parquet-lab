# COPC 生成時間の切り分け (2026-09-05)。
# README の「COPC 生成 69 分 37 秒」が PDAL writers.copc 固有の遅さかを確かめるため、
#   1. writers.copc を点数を変えて (2,607 万 / 1 億 429 万) 計測し、スケーリングを見る
#   2. untwine で全体 (2 億 4,988 万点) を作って比較する
# 実行 (リポジトリルートで): powershell -ExecutionPolicy Bypass -File experiments/copc/copc_bench.ps1
# 結果: results/copc_bench.log (経過時間とプロセスの WorkingSet ピーク)
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..\..")
$PDAL = "C:\mm\pdal\Library\bin\pdal.exe"; $UNT = "C:\mm\pdal\Library\bin\untwine.exe"
$SRC  = "data/09jc602/09jc602.las"; $SRS = "EPSG:6677"
$OUT  = "data"; $LOG = "experiments/copc/results/copc_bench.log"
function Log($m) { "$(Get-Date -Format HH:mm:ss) $m" | Tee-Object -FilePath $LOG -Append }
function Run($label, $proc, $block) {
  Log "### $label start"
  $job = Start-Job -ArgumentList $proc { param($p) $peak = 0; while ($true) { $ws = (Get-Process $p -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum; if ($ws -gt $peak) { $peak = $ws; $peak }; Start-Sleep 5 } }
  $sw = [Diagnostics.Stopwatch]::StartNew(); & $block; $sw.Stop()
  Stop-Job $job; $peaks = Receive-Job $job; Remove-Job $job
  $pk = if ($peaks) { ($peaks | Measure-Object -Maximum).Maximum / 1MB } else { 0 }
  Log ("### $label end  elapsed {0:hh\:mm\:ss}  peak_ws {1:N0} MB" -f $sw.Elapsed, $pk)
}
# 1. writers.copc の点数スケーリング (readers.las.count で先頭 N 点だけ読む)
foreach ($n in 26073803, 104295212) {
  Run "writers.copc $n" "pdal" { & $PDAL translate $SRC "$OUT/copc_scaling_$n.copc.laz" -w writers.copc --readers.las.override_srs=$SRS --readers.las.count=$n }
  Log ("size " + (Get-Item "$OUT/copc_scaling_$n.copc.laz").Length)
}
# 2. untwine で全体。temp_dir は短いパスに (数千ファイルを一時的に作る。終了後に自分で消す)
New-Item -ItemType Directory -Force C:\mm\untwine_tmp | Out-Null
Run "untwine 250M" "untwine" { & $UNT -i $SRC -o "$OUT/09jc602_untwine.copc.laz" --temp_dir C:\mm\untwine_tmp --a_srs $SRS }
Log ("size " + (Get-Item "$OUT/09jc602_untwine.copc.laz").Length)
Remove-Item -Recurse -Force C:\mm\untwine_tmp
Log "DONE"
