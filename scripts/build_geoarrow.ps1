# PDAL が書いた GeoParquet (Snappy, xyz+wkb 二重持ち) を GDAL で
# GeoArrow (struct<x,y,z>) + ZSTD に再エンコードする。
# 座標列が 1 本になり、PDAL 単体では選べない ZSTD も使える。
#
# 要件: OSGeo4W の GDAL 3.13 (Parquet ドライバ同梱)。
# 入力は build.ps1 で作った data/09jc602.parquet。出力も data/ 以下。
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")   # リポジトリルート

$O4W = "C:\OSGeo4W\bin\o4w_env.bat"
$src = "data/09jc602.parquet"
$dst = "data/09jc602_geoarrow.parquet"

# xyz (PDAL の GeoArrow 列) は落とし、wkb を geometry として GDAL に渡す
$cols = "Intensity,ReturnNumber,NumberOfReturns,ScanDirectionFlag,EdgeOfFlightLine,Classification,Synthetic,KeyPoint,Withheld,Overlap,ScanAngleRank,UserData,PointSourceId,GpsTime,Red,Green,Blue"

if (Test-Path $dst) { Remove-Item $dst }
$sw = [Diagnostics.Stopwatch]::StartNew()
# -nlt POINTZ: geo メタデータ上は 2D Point 扱いなので明示しないと Z が落ちる
# WRITE_COVERING_BBOX=NO: 点では bbox 列は冗長 (1M 点で 7 MB、全体の 4 割)
cmd /c "`"$O4W`" >nul && ogr2ogr -f Parquet $dst $src -progress -nlt POINTZ -select $cols -lco GEOMETRY_ENCODING=GEOARROW -lco COMPRESSION=ZSTD -lco ROW_GROUP_SIZE=1000000 -lco WRITE_COVERING_BBOX=NO -lco GEOMETRY_NAME=geometry"
if ($LASTEXITCODE -ne 0) { throw "ogr2ogr failed: $LASTEXITCODE" }
$sw.Stop()
"elapsed: $($sw.Elapsed)"
Get-Item $dst | Select-Object Name, @{n='GB';e={[math]::Round($_.Length/1e9,2)}}
