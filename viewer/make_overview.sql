-- ビューアの初期表示用に 09jc602_geoarrow.parquet から 1% (約 250 万点) を一様ランダム抽出する。
-- 列構成は本体と同じ (geometry struct + 色・属性) にして、ビューアが同じ経路で読めるようにする。
-- 実行 (リポジトリルートで): duckdb -c ".read viewer/make_overview.sql"
-- COPY は geo メタデータを落とすので、QGIS / GDAL でも開きたければ続けて
--   python scripts/copy_geo_metadata.py data/09jc602_geoarrow.parquet data/09jc602_geoarrow_overview.parquet
SET threads = 16;
COPY (
  SELECT geometry, Red, Green, Blue, Classification, Intensity
  FROM 'data/09jc602_geoarrow.parquet'
  USING SAMPLE 1% (bernoulli)
) TO 'data/09jc602_geoarrow_overview.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 500000);
SELECT count(*) AS points FROM 'data/09jc602_geoarrow_overview.parquet';
