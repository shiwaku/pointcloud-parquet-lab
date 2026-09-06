# pointcloud-parquet-lab

航空レーザ点群を **GeoParquet で持つのは実用的か** を、LAS / LAZ / COPC と並べて実測した記録。
2.5 億点 (LAS 8.5 GB) の 1 ファイルを 6 形式に変換し、サイズ・生成時間・範囲クエリ・ブラウザ表示を比べた。

このファイルは要点だけ。数字の根拠、手順の細部、ハマりどころは [REPORT.md](REPORT.md) にある。

## 結論

- **保管・受け渡しは LAZ**。最小 (LAS の 22%)。ただし空間インデックスが無く、範囲抽出は全読み (85 秒)
- **Web 配信・ビューアは COPC**。LAZ の 1.2 倍のサイズで範囲抽出 0.5 秒、LOD 付き。生成は untwine で 5 分半
- **SQL で集計・結合するなら GeoParquet**。列単位の集計が 0.3〜0.6 秒で他形式が勝てない。範囲抽出も row group 統計で 0.1〜1.8 秒
- **属性で絞る処理も GeoParquet + DuckDB**。地盤点 (Classification 2、1,134 万点) の抜き出しが 8 秒。PDAL は LAS / LAZ / COPC のどれからでも 60〜90 秒 ([REPORT 12 章](REPORT.md#12-地盤点-classification-2-の抽出-duckdb-vs-pdal-2026-09-06))
- GeoParquet で LOD 付き配信もできる (PCP、[REPORT 11 章](REPORT.md#11-pcp-point-cloud-parquet-への変換と-r2-配置)) が、読めるビューアが 1 つで要件も変わる。標準の GeoParquet ではない
- Parquet の新エンコード ALP でも LAZ には届かない。差は座標の予測残差符号化と属性列の圧縮にあり、Parquet の枠組みに無い ([REPORT 8 章](REPORT.md#8-alp-を使えば-laz-に近づくか))

## 比較

249,880,253 点。Windows 11 / 64 GB RAM / 16 コア。bbox クエリは 100 m 四方の点数を数えるもので、全形式 449,428 点で一致。

| 形式 | サイズ | LAS 比 | 生成時間 | bbox クエリ |
|---|---|---|---|---|
| LAS (入力) | 8.50 GB | 1.00 | – | 86.3 s |
| GeoParquet (Snappy, PDAL 出力のまま) | 7.87 GB | 0.93 | 約 5 分 | 1.8 s |
| GeoParquet (ZSTD, wkb のみ) | 3.80 GB | 0.45 | +2 分 19 秒 | 5.8 s |
| GeoParquet (ZSTD, GeoArrow struct) | **2.92 GB** | 0.34 | +9 分 06 秒 | **0.1 s** |
| COPC (untwine) | 2.25 GB | 0.26 | **5 分 26 秒** | **0.5 s** |
| PCP (Parquet, Morton 順 + LOD) | 2.32 GB | 0.27 | +14 分 38 秒 | 0.2 s |
| LAZ | **1.90 GB** | **0.22** | 3 分 52 秒 | 84.6 s |

「+」は PDAL 出力 (約 5 分) からの追加時間。

| 用途 | 形式 |
|---|---|
| 保管・受け渡し | LAZ |
| Web 配信・ビューア | COPC (生成は untwine)。Parquet で揃えたいなら PCP |
| DuckDB spatial の `ST_*` で集計・結合 | GeoParquet (ZSTD + wkb) |
| 座標を数値として扱う、bbox 抽出、容量も抑える | GeoParquet (ZSTD + GeoArrow struct)。DuckDB spatial 1.1.3 では読めない |
| GDAL / QGIS から読む | どの GeoParquet でも可。QGIS では 200 m 四方の表示が 5.5 秒、全域は 1% サンプルで。3D ビューも範囲を絞れば可 (標高色)。3D で RGB なら COPC ([REPORT 9 章](REPORT.md#qgis-で開く-2026-09-06)) |

## 作ったもの

- **変換スクリプト** (`scripts/`): PDAL / untwine / GDAL / DuckDB で LAS から全形式を生成する。`build.ps1` で一括
- **GeoParquet ブラウザビューア** (`viewer/`): GeoArrow 版を hyparquet + deck.gl で開き、footer の row group 統計だけで画面内の row group を Range request で部分読みする。2.92 GB を変換せずに表示できる。LOD は無い
- **QGIS スタイル** (`qgis/`): 標高 (10 m 刻み) と RGB の QML。2D と 3D ビューの設定を含む。3D は `max-chunk-features` を上げないと点群が描かれない ([REPORT 9 章](REPORT.md#3d-表示-2026-09-06))
- **MapLibre 版** (`viewer/maplibre.html`): 同じ仕組みで読んだ点を Worker 内で proj4 により EPSG:6677 → WGS84 に変換し、deck.gl の `MapboxOverlay` で地理院タイルの上に重ねる。MapLibre 自体は GeoParquet を読めないのでこの構成になる ([REPORT 10 章](REPORT.md#maplibre-版-viewermaplibrehtml2026-09-06))
- **PCP 変換** (`scripts/build_pcp.py`): GeoArrow 版を Morton 順 + additive voxel LOD の Parquet に並べ替え、[kanahiro.github.io/pcp](https://kanahiro.github.io/pcp/) で開けるようにする。R2 に置いた [全体 2.3 GB](https://shi-works.com/geoparquet/pcp/09jc602_pcp.parquet) は初期表示 0.9 MB の読み込みで済む

![自作ビューア。緑の枠が読み込み済みの row group](docs/images/viewer_detail_elevation.png)

## 再現

入力 `data/09jc602/09jc602.las` (LAS 1.2 PDRF 3、CRS 無し。EPSG:6677 と推定して付与) を置いてリポジトリルートで実行する。

```powershell
.\scripts\setup_pdal.ps1                     # 初回のみ。conda-forge の PDAL 2.10 + untwine を C:\mm\pdal に
.\scripts\build.ps1                          # LAZ / COPC / GeoParquet (Snappy, ZSTD+wkb)
.\scripts\build_geoarrow.ps1                 # GeoArrow struct 版 (OSGeo4W の GDAL 3.13)
duckdb -c ".read viewer/make_overview.sql"   # ビューア用の 1% サンプル
python scripts/copy_geo_metadata.py data/09jc602_geoarrow.parquet data/09jc602_geoarrow_overview.parquet   # サンプルを QGIS でも開けるように
python viewer/serve.py                       # http://127.0.0.1:8080/viewer/ (MapLibre 版は /viewer/maplibre.html)
python scripts/build_pcp.py data/09jc602_geoarrow.parquet data/09jc602_pcp.parquet   # PCP (約 5 分半)
```

`data/` は git 管理外 (合計 40 GB 弱)。環境ごとの注意点は [REPORT 4 章](REPORT.md#4-環境)、
つまずいたときは [付録 B ハマりどころ索引](REPORT.md#付録-b-ハマりどころ索引)。

## 構成

```
scripts/        変換・検証スクリプト (PDAL パイプライン, DuckDB SQL, PCP 変換, R2 アップロード)
viewer/         GeoParquet ビューア (index.html, app.js) と MapLibre 版 (maplibre.html, maplibre.js)。worker.js / points.js を共用。puppeteer テストは dev/
experiments/    ALP エンコードの検証、COPC 生成時間の切り分け、地盤点抽出の DuckDB vs PDAL (results/ にログ)
qgis/           QGIS 用 QML (標高 / RGB)。scripts/make_qgis_styles.py が生成
docs/images/    スクリーンショット
REPORT.md       作業記録の全文 (入力データ、環境、手順、計測、ビューア調査、PCP、残課題)
```

## 未解決

- CRS EPSG:6677 はファイル名と座標からの推定
- 自作ビューアに LOD が無い (概観 1% と詳細 100% の 2 段階のみ)。wkb 版も読めない
- PCP ビューアの検証ルールは更新で変わる。2026-09-05 に `voxel_edge_ratio` と PROJJSON の `crs` が必須になり再生成した
