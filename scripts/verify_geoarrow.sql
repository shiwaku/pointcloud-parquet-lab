-- 09jc602_geoarrow.parquet (GDAL, GeoArrow struct<x,y,z> + ZSTD) の検証
-- 実行 (リポジトリルートで): duckdb -c ".read scripts/verify_geoarrow.sql"
.timer on

-- スキーマ (geometry が STRUCT(x,y,z) になっているか)
DESCRIBE SELECT * FROM 'data/09jc602_geoarrow.parquet';

-- GeoParquet メタデータ
SELECT decode(value) FROM parquet_kv_metadata('data/09jc602_geoarrow.parquet') WHERE CAST(key AS VARCHAR)='geo';

-- 行数・範囲 (LAS: 249,880,253 点, X -78000〜-76000.01, Z 427.77〜877.93)
SELECT count(*), min(geometry.x), max(geometry.x), min(geometry.z), max(geometry.z) FROM 'data/09jc602_geoarrow.parquet';

-- 列ごとの圧縮後サイズ
SELECT path_in_schema,
       round(sum(total_compressed_size)/1e9, 3) AS comp_GB,
       round(100.0*sum(total_compressed_size)/sum(total_uncompressed_size), 0) AS pct,
       any_value(compression) AS codec
FROM parquet_metadata('data/09jc602_geoarrow.parquet') GROUP BY 1 ORDER BY 2 DESC;
SELECT count(DISTINCT row_group_id) AS row_groups FROM parquet_metadata('data/09jc602_geoarrow.parquet');

-- bbox クエリ (他形式と同じ 100 m 四方, 期待値 449,428 点)
SELECT count(*) FROM 'data/09jc602_geoarrow.parquet'
WHERE geometry.x BETWEEN -77100 AND -77000 AND geometry.y BETWEEN 11000 AND 11100;

-- Z 値の統計
SELECT min(geometry.z), max(geometry.z) FROM 'data/09jc602_geoarrow.parquet';

-- Classification 別点数
SELECT Classification, count(*) FROM 'data/09jc602_geoarrow.parquet' GROUP BY 1 ORDER BY 1;
