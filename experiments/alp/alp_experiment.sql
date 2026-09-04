-- ALP (整数格納) を模した実験: 座標を LAS と同じ int32 スケール値 (×100) に戻して Parquet に書く
-- 入力: 09jc602_geoarrow.parquet (GeoArrow struct + ZSTD, GDAL 出力)
-- 有効な GeoParquet ではない (geo メタデータ無し)。サイズ比較のみが目的。
-- 実行 (リポジトリルートで): duckdb -c ".read experiments/alp/alp_experiment.sql"
-- 注意: B, C の PARQUET_VERSION V2 は DuckDB 1.2 以降が必要。1.1.3 では
--   "Unrecognized option for PARQUET: PARQUET_VERSION" で失敗するので、B, C は experiments/alp/alp_experiment_pyarrow.py で作った。
SET threads = 16;
SET preserve_insertion_order = true;

CREATE VIEW pts AS
SELECT CAST(round(geometry.x * 100) AS INTEGER) AS xi,
       CAST(round(geometry.y * 100) AS INTEGER) AS yi,
       CAST(round(geometry.z * 100) AS INTEGER) AS zi,
       Intensity, ReturnNumber, NumberOfReturns, ScanDirectionFlag, EdgeOfFlightLine,
       Classification, Synthetic, KeyPoint, Withheld, Overlap, ScanAngleRank, UserData,
       PointSourceId, GpsTime, Red, Green, Blue
FROM 'data/09jc602_geoarrow.parquet';

-- A: int32 座標 + ZSTD, Parquet V1 (PLAIN / 辞書)
.timer on
COPY pts TO 'data/09jc602_int32_v1.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000);

-- B: int32 座標 + ZSTD, Parquet V2 (DELTA_BINARY_PACKED が使われる。連続点の差分が小さいので効くはず)
COPY pts TO 'data/09jc602_int32_v2.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000, PARQUET_VERSION V2);

-- C: double 座標のまま Parquet V2 (BYTE_STREAM_SPLIT)。ALP 無しの double 格納との比較用
COPY (SELECT geometry.x AS x, geometry.y AS y, geometry.z AS z,
             Intensity, ReturnNumber, NumberOfReturns, ScanDirectionFlag, EdgeOfFlightLine,
             Classification, Synthetic, KeyPoint, Withheld, Overlap, ScanAngleRank, UserData,
             PointSourceId, GpsTime, Red, Green, Blue
      FROM 'data/09jc602_geoarrow.parquet')
TO 'data/09jc602_double_v2.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000, PARQUET_VERSION V2);
.timer off
