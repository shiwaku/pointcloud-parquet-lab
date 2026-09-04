# DuckDB 自身のストレージは double 列に ALP を実装している (v0.10 以降)。
# 本物の ALP でこのデータの座標がどこまで縮むかを、列ごとに別 DB ファイルを作ってファイルサイズで測る。
# (DuckDB 1.1.3 の pragma_storage_info はセグメントサイズを返さないため)
# Parquet ではなく DuckDB DB ファイルでの実測。実行 (リポジトリルートで): .\experiments\alp\alp_duckdb_native.ps1
$N = 249880253
foreach ($c in @("x", "y", "z", "GpsTime")) {
    $db = "data/alp_$c.duckdb"
    Remove-Item -ErrorAction SilentlyContinue $db, "$db.wal"
    $expr = if ($c -eq "GpsTime") { "GpsTime" } else { "geometry.$c AS $c" }
    duckdb $db -c "SET threads=8; SET preserve_insertion_order=true; CREATE TABLE t AS SELECT $expr FROM 'data/09jc602_geoarrow.parquet'; CHECKPOINT; SELECT column_name, compression, count(*) AS segments FROM pragma_storage_info('t') WHERE segment_type <> 'VALIDITY' GROUP BY 1,2;"
    $size = (Get-Item $db).Length
    "{0}: {1:N3} GB = {2:N2} B/pt" -f $c, ($size / 1e9), ($size / $N)
    Remove-Item $db
}
