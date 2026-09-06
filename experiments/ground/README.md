# 地盤点 (Classification 2) の抽出: DuckDB vs PDAL

2026-09-06。DEM を作るための地盤点だけを 09jc602 (249,880,253 点) から抜き出す処理を、
GeoParquet + DuckDB 1.1.3 と LAS/LAZ/COPC + PDAL 2.10.2 で比べた。環境は 64 GB RAM / 16 コア。
詳しい考察は [REPORT.md 12 章](../../REPORT.md#12-地盤点-classification-2-の抽出-duckdb-vs-pdal-2026-09-06)。

- スクリプト: `ground_bench.ps1` (リポジトリルートで `powershell -ExecutionPolicy Bypass -File experiments/ground/ground_bench.ps1`)
- ログ: `results/ground_bench.log`
- 出力: `data/ground/` (git 管理外)
- 分類の内訳: 2 (地盤) 11,340,200 点 4.5 % / 5 (高植生) 86.2 % / 6 (建物) 9.2 %。この 3 クラスのみ

## ケース設計

| ケース | 目的 | DuckDB 側 | PDAL 側 |
|---|---|---|---|
| A. 全域を書き出す | 本命。DEM 用データを作る | GeoParquet 3 種 (GeoArrow / ZSTD+wkb / Snappy) → GeoParquet (ZSTD) | LAS / LAZ / COPC → LAZ (`filters.range Classification[2:2]`)。出力形式を揃えるため LAS → GeoParquet (`writers.arrow`) も |
| B. 数えるだけ | 読み + フィルタの純コスト (書き出しを除く) | `SELECT count(*) WHERE Classification = 2` | `filters.range` → `writers.null` |
| C. 100 m 四方だけ | 空間インデックスが効く場面 | GeoArrow 版に bbox + class 条件 (row group 統計で読み飛ばし) | COPC は `readers.copc.bounds`、LAZ は `filters.crop` (全読み) |

全ケースで出力点数が一致することを確認する (全域 11,340,200 点、100 m 四方 91,512 点)。

## 結果

### A. 全域の地盤点を書き出す

| ケース | 入力 | 出力 | 時間 | 出力サイズ |
|---|---|---|---|---|
| D1 DuckDB | `09jc602_geoarrow.parquet` (ZSTD, struct) | GeoParquet (ZSTD, struct) | **8.2 s** (+ `geo` 付与 4.2 s) | 150 MB |
| D2 DuckDB | `09jc602_zstd.parquet` (ZSTD, wkb) | GeoParquet (ZSTD, wkb) | 7.0 s (+ `geo` 付与 4.7 s) | 212 MB |
| D3 DuckDB | `09jc602.parquet` (Snappy, xyz+wkb) | GeoParquet (ZSTD, wkb) | 10.4 s | 202 MB |
| P1 PDAL | `09jc602.las` (8.5 GB) | LAZ | 60.7 s | 107 MB |
| P2 PDAL | `09jc602.laz` (1.9 GB) | LAZ | 65.0 s | 107 MB |
| P3 PDAL | `09jc602_untwine.copc.laz` (2.3 GB) | LAZ | 91.2 s | 125 MB |
| P4 PDAL | `09jc602.las` | GeoParquet (`writers.arrow`, Snappy) | 88.2 s | 395 MB |

### B. 数えるだけ

| ツール | 入力 | 時間 |
|---|---|---|
| DuckDB | geoarrow / zstd / snappy | 0.4 / 0.3 / 0.5 s |
| PDAL (`writers.null`) | LAS / LAZ / COPC | 88.1 / 78.9 / 84.6 s |

### C. 100 m 四方 (X -77100〜-77000, Y 11000〜11100)

| ツール | 方法 | 時間 | 点数 |
|---|---|---|---|
| DuckDB (geoarrow) | bbox + class → GeoParquet | **0.5 s** | 91,512 |
| PDAL (COPC) | `readers.copc.bounds` + `filters.range` → LAZ | **0.6 s** | 91,512 |
| PDAL (LAZ) | `filters.crop` + `filters.range` → LAZ (全読み) | 79.2 s | 91,512 |

## 分かったこと

- **属性で絞る処理は DuckDB + GeoParquet が PDAL の 7〜11 倍速い** (8 秒 vs 60〜90 秒)。Classification 列だけ先に読んで
  該当行の他列を取り、16 スレッドで row group を並列処理するため
- PDAL は入力形式を変えても 60〜90 秒で差が小さい。ボトルネックは I/O ではなく単一スレッドの点処理。
  書き出しを省いた B が A より遅いこともあり、実行ごとに 15〜30 秒ばらつく
- COPC 入力は全点を読む用途では LAZ 入力より遅く、出力 LAZ も大きい (125 MB vs 107 MB)。八分木の走査と、
  出力が空間順になって LAZ の前点予測が効きにくくなるため
- PDAL の GeoParquet 出力は 395 MB。`writers.arrow` は Snappy 固定で xyz と wkb を二重に持つ
- 範囲を絞る用途では GeoParquet (row group 統計) と COPC (八分木) が同等の 0.5 秒、LAZ だけ全読みで 79 秒
- DEM 用の出力は、QGIS で読むなら D1 の GeoArrow 版 (150 MB、`geo` 付与済み)、PDAL `writers.gdal` でラスタ化するなら LAZ (107 MB)

## 未計測

抽出後にラスタ DEM を作る段 (PDAL `writers.gdal` の IDW / mean、または DuckDB で格子集計 → GDAL)。

## 注意

- `ground_bench.ps1` は BOM 付き UTF-8。Windows PowerShell 5.1 は BOM 無しの UTF-8 を Shift-JIS として読み、
  日本語コメントの直後の引用符が壊れて構文エラーになる
- `Tee-Object` のログは UTF-16 で書かれるので、`results/` に置く前に UTF-8 に変換している
