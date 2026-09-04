<#
data/09jc602/09jc602.las から LAZ / COPC / GeoParquet を生成する一連の処理。
どこから実行しても、入出力はリポジトリルートの data/ 以下。

前提:
  - PDAL 2.10.2 (conda-forge, arrow プラグイン入り) が C:\mm\pdal にあること
    → 未構築なら .\scripts\setup_pdal.ps1 を先に実行
  - duckdb CLI が PATH にあること
  - python が PATH にあること (make_repack_sql.py 用)

注意:
  OSGeo4W 版 PDAL 2.10.0-4 は arrow プラグインを同梱しているが
  parquet 書き出しで必ずクラッシュする (0xC0000409 / 出力 4 バイト)。
  feather は正常。詳細は README.md 参照。
#>

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")   # リポジトリルート

$PDAL = "C:\mm\pdal\Library\bin\pdal.exe"
$SRC  = "data/09jc602/09jc602.las"
$SRS  = "EPSG:6677"   # JGD2011 / 平面直角座標系 IX 系。LAS に測地情報が無いため付与する

function Step($label, $block) {
    Write-Host "### $label  $(Get-Date -Format HH:mm:ss)" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $block
    $sw.Stop()
    Write-Host ("    elapsed {0:mm\:ss}" -f $sw.Elapsed)
}

# --- 1. GeoParquet (PDAL writers.arrow, Snappy 固定 / xyz + wkb の 2 列を持つ) -----
# パイプライン定義は scripts/las2geoparquet.json (パスはリポジトリルート基準)
Step "GeoParquet (writers.arrow)" {
    & $PDAL pipeline scripts/las2geoparquet.json
}

# --- 2. LAZ ---------------------------------------------------------------------
Step "LAZ" {
    & $PDAL translate $SRC data/09jc602.laz --readers.las.override_srs=$SRS
}

# --- 3. COPC --------------------------------------------------------------------
Step "COPC" {
    & $PDAL translate $SRC data/09jc602.copc.laz -w writers.copc --readers.las.override_srs=$SRS
}

# --- 4. GeoParquet を ZSTD + wkb のみに再パック -----------------------------------
# writers.arrow には圧縮方式の指定も xyz/wkb を落とすオプションも無いので後処理で行う
Step "GeoParquet repack (ZSTD + wkb only)" {
    python scripts/make_repack_sql.py data/09jc602.parquet data/09jc602_zstd.parquet scripts/repack_zstd.sql
    duckdb -c ".read scripts/repack_zstd.sql"
}

# --- 5. 結果一覧 ------------------------------------------------------------------
Write-Host "`n### sizes" -ForegroundColor Cyan
Get-ChildItem data/09jc602/09jc602.las, data/09jc602.laz, data/09jc602.copc.laz, data/09jc602.parquet, data/09jc602_zstd.parquet |
    Select-Object Name, @{n = 'GB'; e = { [math]::Round($_.Length / 1GB, 2) } },
                        @{n = 'bytes_per_point'; e = { [math]::Round($_.Length / 249880253, 1) } } |
    Format-Table -AutoSize
