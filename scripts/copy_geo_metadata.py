#!/usr/bin/env python3
"""GeoParquet の `geo` メタデータを別の Parquet に写す。

DuckDB の COPY は key_value_metadata を落とすので、DuckDB で作ったサンプル
(viewer/make_overview.sql の出力など) は列構成が同じでも GeoParquet として認識されない
(ogrinfo で Geometry: None、QGIS ではジオメトリ無しテーブル)。
元ファイルの `geo` を付け直せば GDAL / QGIS でそのまま点レイヤとして開ける。

使い方: python scripts/copy_geo_metadata.py SRC.parquet DST.parquet
DST を行グループ構成・圧縮を保ったまま書き直す (一時ファイル経由)。
"""
import json
import os
import sys

import pyarrow.parquet as pq


def main(src, dst):
    geo = pq.ParquetFile(src).metadata.metadata[b"geo"]
    g = json.loads(geo)
    pf = pq.ParquetFile(dst)
    for name in g["columns"]:
        if name not in pf.schema_arrow.names:
            sys.exit(f"{dst} に列 {name} が無い")
    # bbox は DST の中身と合わないかもしれないので落とす (GeoParquet では任意項目)
    for c in g["columns"].values():
        c.pop("bbox", None)
        c.pop("covering", None)
    md = dict(pf.schema_arrow.metadata or {})
    md[b"geo"] = json.dumps(g, separators=(",", ":")).encode()
    schema = pf.schema_arrow.with_metadata(md)
    codec = pf.metadata.row_group(0).column(0).compression.lower()
    tmp = dst + ".tmp"
    with pq.ParquetWriter(tmp, schema, compression=codec, write_statistics=True) as w:
        for i in range(pf.metadata.num_row_groups):
            w.write_table(pf.read_row_group(i).cast(schema))
    n_rg = pf.metadata.num_row_groups
    pf.close()                      # Windows では開いたままだと置き換えられない
    os.replace(tmp, dst)
    print(f"{dst}: geo メタデータを {src} から写した (primary_column={g['primary_column']}, "
          f"encoding={g['columns'][g['primary_column']]['encoding']}, {n_rg} row groups, {codec})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
