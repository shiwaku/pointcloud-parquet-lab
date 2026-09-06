# 地盤点 (Classification = 2) の抽出: DuckDB (GeoParquet) と PDAL (LAS / LAZ / COPC) の処理時間比較。
# リポジトリルートで実行する。出力は data/ground/ (git 管理外)、ログは experiments/ground/results/ground_bench.log
#   powershell -ExecutionPolicy Bypass -File experiments/ground/ground_bench.ps1
# ケース:
#   A. 全域の地盤点をファイルに書き出す
#        D1 DuckDB  09jc602_geoarrow.parquet (ZSTD, struct) -> GeoParquet (ZSTD, struct) + geo メタデータ付与
#        D2 DuckDB  09jc602_zstd.parquet (ZSTD, wkb)        -> GeoParquet (ZSTD, wkb)
#        D3 DuckDB  09jc602.parquet (Snappy, xyz+wkb)      -> GeoParquet (ZSTD, wkb のみ)
#        P1 PDAL    LAS  -> LAZ   (filters.range Classification[2:2])
#        P2 PDAL    LAZ  -> LAZ
#        P3 PDAL    COPC -> LAZ
#        P4 PDAL    LAS  -> GeoParquet (writers.arrow)   出力形式を DuckDB と揃える
#   B. 数えるだけ (読み + フィルタ。書き出し無し)
#        DuckDB 3 ファイル: SELECT count(*) WHERE Classification = 2
#        PDAL   LAS / LAZ / COPC -> writers.null
#   C. 100 m 四方 (X -77100..-77000, Y 11000..11100) の地盤点を LAZ / GeoParquet に
#        DuckDB geoarrow (row group 統計で読み飛ばし) / PDAL COPC (readers.copc.bounds) / PDAL LAZ (全読み + filters.crop)
$ErrorActionPreference = "Stop"
$PDAL = "C:\mm\pdal\Library\bin\pdal.exe"
$SRS = "EPSG:6677"
$OUT = "data\ground"
$LOG = "experiments\ground\results\ground_bench.log"
New-Item -ItemType Directory -Force $OUT | Out-Null
"# ground_bench $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  PDAL 2.10.2 / DuckDB 1.1.3 / 16 threads" | Tee-Object -FilePath $LOG

function Run($name, [scriptblock]$body) {
  $t = Measure-Command { & $body | Out-Null }
  $line = "{0,-58} {1,8:N1} s" -f $name, $t.TotalSeconds
  $line | Tee-Object -FilePath $LOG -Append
}
function Size($path) { if (Test-Path $path) { "{0,-58} {1,8:N0} MB" -f "  size $path", ((Get-Item $path).Length / 1e6) | Tee-Object -FilePath $LOG -Append } }
function Count($path) {
  $n = & duckdb -csv -noheader -c "SELECT count(*) FROM read_parquet('$($path.Replace([char]92, '/'))')"
  "{0,-58} {1,14:N0} points" -f "  count $path", [long]$n | Tee-Object -FilePath $LOG -Append
}
function CountLas($path) {
  $j = & $PDAL info --summary $path | ConvertFrom-Json
  "{0,-58} {1,14:N0} points" -f "  count $path", [long]$j.summary.num_points | Tee-Object -FilePath $LOG -Append
}

"## A. 全域の地盤点を書き出す" | Tee-Object -FilePath $LOG -Append
Run "D1 DuckDB geoarrow -> GeoParquet(struct, ZSTD)" {
  duckdb -c "SET threads=16; COPY (SELECT * FROM 'data/09jc602_geoarrow.parquet' WHERE Classification = 2) TO 'data/ground/ground_d1_geoarrow.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)"
}
Run "D1b   + geo メタデータ付与 (copy_geo_metadata.py)" { python scripts/copy_geo_metadata.py data/09jc602_geoarrow.parquet data/ground/ground_d1_geoarrow.parquet }
Size "$OUT\ground_d1_geoarrow.parquet"; Count "$OUT\ground_d1_geoarrow.parquet"

Run "D2 DuckDB zstd(wkb) -> GeoParquet(wkb, ZSTD)" {
  duckdb -c "SET threads=16; COPY (SELECT * FROM 'data/09jc602_zstd.parquet' WHERE Classification = 2) TO 'data/ground/ground_d2_wkb.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)"
}
Run "D2b   + geo メタデータ付与" { python scripts/copy_geo_metadata.py data/09jc602_zstd.parquet data/ground/ground_d2_wkb.parquet }
Size "$OUT\ground_d2_wkb.parquet"; Count "$OUT\ground_d2_wkb.parquet"

Run "D3 DuckDB snappy(xyz+wkb) -> GeoParquet(wkb, ZSTD)" {
  duckdb -c "SET threads=16; COPY (SELECT * EXCLUDE (xyz) FROM 'data/09jc602.parquet' WHERE Classification = 2) TO 'data/ground/ground_d3_snappy_src.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000)"
}
Size "$OUT\ground_d3_snappy_src.parquet"; Count "$OUT\ground_d3_snappy_src.parquet"

Run "P1 PDAL LAS -> LAZ (filters.range)" {
  & $PDAL translate data\09jc602\09jc602.las $OUT\ground_p1_las.laz range --filters.range.limits="Classification[2:2]" --readers.las.override_srs=$SRS
}
Size "$OUT\ground_p1_las.laz"; CountLas "$OUT\ground_p1_las.laz"

Run "P2 PDAL LAZ -> LAZ" {
  & $PDAL translate data\09jc602.laz $OUT\ground_p2_laz.laz range --filters.range.limits="Classification[2:2]"
}
Size "$OUT\ground_p2_laz.laz"; CountLas "$OUT\ground_p2_laz.laz"

Run "P3 PDAL COPC -> LAZ" {
  & $PDAL translate data\09jc602_untwine.copc.laz $OUT\ground_p3_copc.laz range --filters.range.limits="Classification[2:2]"
}
Size "$OUT\ground_p3_copc.laz"; CountLas "$OUT\ground_p3_copc.laz"

Run "P4 PDAL LAS -> GeoParquet (writers.arrow)" {
  & $PDAL translate data\09jc602\09jc602.las $OUT\ground_p4_las.parquet range --filters.range.limits="Classification[2:2]" --readers.las.override_srs=$SRS --writers.arrow.format=geoparquet --writers.arrow.batch_size=262144
}
Size "$OUT\ground_p4_las.parquet"; Count "$OUT\ground_p4_las.parquet"

"## B. 数えるだけ (書き出し無し)" | Tee-Object -FilePath $LOG -Append
Run "DuckDB count geoarrow" { duckdb -c "SET threads=16; SELECT count(*) FROM 'data/09jc602_geoarrow.parquet' WHERE Classification = 2" }
Run "DuckDB count zstd(wkb)" { duckdb -c "SET threads=16; SELECT count(*) FROM 'data/09jc602_zstd.parquet' WHERE Classification = 2" }
Run "DuckDB count snappy" { duckdb -c "SET threads=16; SELECT count(*) FROM 'data/09jc602.parquet' WHERE Classification = 2" }
Run "PDAL LAS  -> filters.range -> writers.null" { & $PDAL translate data\09jc602\09jc602.las $OUT\null.tmp range --filters.range.limits="Classification[2:2]" --writer null }
Run "PDAL LAZ  -> filters.range -> writers.null" { & $PDAL translate data\09jc602.laz $OUT\null.tmp range --filters.range.limits="Classification[2:2]" --writer null }
Run "PDAL COPC -> filters.range -> writers.null" { & $PDAL translate data\09jc602_untwine.copc.laz $OUT\null.tmp range --filters.range.limits="Classification[2:2]" --writer null }

"## C. 100 m 四方の地盤点 (X -77100..-77000, Y 11000..11100)" | Tee-Object -FilePath $LOG -Append
Run "DuckDB geoarrow bbox+class -> GeoParquet" {
  duckdb -c "SET threads=16; COPY (SELECT * FROM 'data/09jc602_geoarrow.parquet' WHERE Classification = 2 AND geometry.x BETWEEN -77100 AND -77000 AND geometry.y BETWEEN 11000 AND 11100) TO 'data/ground/ground_bbox_duckdb.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"
}
Count "$OUT\ground_bbox_duckdb.parquet"
Run "PDAL COPC readers.copc.bounds + range -> LAZ" {
  & $PDAL translate data\09jc602_untwine.copc.laz $OUT\ground_bbox_copc.laz range --readers.copc.bounds="([-77100,-77000],[11000,11100])" --filters.range.limits="Classification[2:2]"
}
CountLas "$OUT\ground_bbox_copc.laz"
Run "PDAL LAZ filters.crop + range -> LAZ (全読み)" {
  & $PDAL translate data\09jc602.laz $OUT\ground_bbox_laz.laz crop range --filters.crop.bounds="([-77100,-77000],[11000,11100])" --filters.range.limits="Classification[2:2]"
}
CountLas "$OUT\ground_bbox_laz.laz"
"# done $(Get-Date -Format 'HH:mm:ss')" | Tee-Object -FilePath $LOG -Append
