-- PCP (Point Cloud Parquet, kanahiro.github.io/pcp) 用の中間ファイルを作る DuckDB SQL テンプレート。
-- build_pcp.py が {{...}} 形式の穴を埋めて実行する (埋めた結果は <出力>.sql として残る)。
--
-- 入力: GeoArrow struct<x,y,z> の GeoParquet (09jc602_geoarrow.parquet)
-- 出力: 全点を Morton (Z-order) 順に並べ、additive voxel-first の LOD レベルを付けた Parquet
--       (level, code 順。build_pcp.py がレベル境界に揃えた row group に書き直す)
--
-- LOD の決め方 (hierarchy = additive_voxel_first):
--   座標を 0.01 m の整数格子に量子化し、最小座標からの相対値 (18 bit) を Morton 符号にする。
--   レベル k のボクセル 1 辺 = 2^(COARSEST_SHIFT - k) 格子単位。
--   Morton 順では同じボクセルの点が連続するので、直前の点とボクセルが異なる (= その点が
--   ボクセルの先頭) 最も粗いレベルにその点を割り当てる。どのボクセルレベルでも先頭に
--   ならない点 (最小ボクセル内の 2 点目以降) は最後の「余り」レベルへ。
--   → 各点はちょうど 1 レベルに属し、全レベルの和 = 全点 (additive)。
SET threads = {THREADS};
SET memory_limit = '{MEMORY}';
SET temp_directory = '{TMP}';
SET preserve_insertion_order = false;

-- 18 bit 整数の各ビットを 3 bit 間隔に広げる (DuckDB は左シフトの桁あふれをエラーにするので
-- マジックナンバー方式ではなくビットごとの和で書く)
CREATE MACRO spread3(v) AS ({SPREAD3});
CREATE MACRO morton3(x, y, z) AS spread3(x::BIGINT) | (spread3(y::BIGINT) << 1) | (spread3(z::BIGINT) << 2);

COPY (
  WITH q AS (
    SELECT
      round(geometry.x * {INV_SCALE})::INTEGER AS x,
      round(geometry.y * {INV_SCALE})::INTEGER AS y,
      round(geometry.z * {INV_SCALE})::INTEGER AS z,
      -- LAS 1.2 PDRF3 の RGB は 8 bit。PCP は 65535 で割るので 16 bit に伸長する
      (Red   * 257)::USMALLINT AS red,
      (Green * 257)::USMALLINT AS green,
      (Blue  * 257)::USMALLINT AS blue,
      Intensity::USMALLINT          AS intensity,
      ReturnNumber::UTINYINT        AS return_number,
      NumberOfReturns::UTINYINT     AS number_of_returns,
      (ScanDirectionFlag = 1)       AS scan_direction_flag,
      (EdgeOfFlightLine = 1)        AS edge_of_flight_line,
      Classification::UTINYINT      AS classification,
      (Synthetic = 1)               AS synthetic,
      (KeyPoint = 1)                AS key_point,
      (Withheld = 1)                AS withheld,
      (Overlap = 1)                 AS overlap,
      round(ScanAngleRank)::SMALLINT AS scan_angle,
      UserData::UTINYINT            AS user_data,
      PointSourceId::USMALLINT      AS point_source_id,
      GpsTime                       AS gps_time
    FROM read_parquet('{INPUT}')
    WHERE {WHERE}
  ),
  m AS (
    SELECT *, morton3(x - {XMIN}, y - {YMIN}, z - {ZMIN}) AS code FROM q
  ),
  w AS (
    SELECT *, xor(code, lag(code) OVER (ORDER BY code)) AS d FROM m
  )
  SELECT
    * EXCLUDE (d),
    (CASE WHEN d IS NULL THEN 0 {LEVEL_CASES} ELSE {REMAINDER_LEVEL} END)::UTINYINT AS level
  FROM w
  ORDER BY level, code
) TO '{OUTPUT}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1048576);
