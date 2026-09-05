# GeoArrow GeoParquet → PCP (Point Cloud Parquet) を作り、Cloudflare R2 に置く。
# リポジトリルートで実行する。詳細は REPORT.md の「PCP」節と scripts/build_pcp.py の docstring。
$ErrorActionPreference = "Stop"

# 1. 変換 (250M 点。DuckDB のソートに数十 GB の spill が出るので C:/mm/duckdb_tmp を使う)
python scripts/build_pcp.py data/09jc602_geoarrow.parquet data/09jc602_pcp.parquet

# 動作確認用の小さいファイル (200 m 四方、約 212 万点)
# python scripts/build_pcp.py data/09jc602_geoarrow.parquet data/09jc602_pcp_test.parquet `
#   --where "geometry.x BETWEEN -77200 AND -77000 AND geometry.y BETWEEN 11000 AND 11200"

# 2. R2 へアップロード (AWS CLI の S3 互換。プロファイル r2-shiworks は ~/.aws/config に定義済み)
#    バケット shi-works は Cloudflare Worker 経由で https://shi-works.com/ から配信され、
#    CORS (AllowedOrigins *, Range 許可, Content-Range 露出) は 2026-08-16 に設定済み
#    (構成は C:\Users\yshiw\Documents\xserver-cleanup\R2-STRUCTURE.md)。
#    キーは第 1 階層 = アクセス方法の規約に従い geoparquet/ 以下に置く (2026-09-04 実施)
$Bucket = "shi-works"
aws s3 cp data/09jc602_pcp.parquet "s3://$Bucket/geoparquet/pcp/09jc602_pcp.parquet" --profile r2-shiworks `
  --content-type application/vnd.apache.parquet
# テスト用 (200 m 四方)
# aws s3 cp data/09jc602_pcp_test.parquet "s3://$Bucket/geoparquet/pcp/09jc602_pcp_test.parquet" --profile r2-shiworks `
#   --content-type application/vnd.apache.parquet
# CORS を別バケットに当てる場合 (shi-works には不要):
# aws s3api put-bucket-cors --bucket $Bucket --cors-configuration file://scripts/r2_cors.json --profile r2-shiworks

# 3. https://kanahiro.github.io/pcp/ の「Parquet source」に公開 URL を入れて Open
#    https://shi-works.com/geoparquet/pcp/09jc602_pcp.parquet
#    https://shi-works.com/geoparquet/pcp/09jc602_pcp_test.parquet
#    headless Chrome で確認するなら (puppeteer-core が必要):
#    node viewer/dev/test_pcp.mjs https://shi-works.com/geoparquet/pcp/09jc602_pcp_test.parquet
#    ビューアの検証ルールは更新で変わる (2026-09-05 に voxel_edge_ratio / PROJJSON crs が必須になった)。
#    "Invalid point_cloud metadata" が出たら worker JS の isPointCloudMetadata 相当を読み直して build_pcp.py を合わせる
