#!/usr/bin/env python3
"""PDAL が書いた GeoParquet から 'geo' メタデータを取り出し、
ZSTD + wkb のみに再パックする DuckDB SQL を生成する。

PDAL writers.arrow は座標を xyz(GeoArrow struct) と wkb(WKB) の
2 列に重複して持ち、圧縮は Snappy 固定。
xyz を落として ZSTD をかけると 7.87GB -> 3.7GB 程度になる。
wkb 側を残すのは GeoParquet の primary_column がそれを指しているため。

DuckDB の COPY は元ファイルの key-value メタデータを引き継がないので、
'geo' を KV_METADATA で明示的に付け直す。
"""
import json
import os
import subprocess
import sys
import tempfile

SRC = sys.argv[1] if len(sys.argv) > 1 else "data/09jc602.parquet"
DST = sys.argv[2] if len(sys.argv) > 2 else "data/09jc602_zstd.parquet"
OUT = sys.argv[3] if len(sys.argv) > 3 else "scripts/repack_zstd.sql"
# DuckDB の一時領域。数十 GB 使うので、空きのあるドライブを環境変数 DUCKDB_TMP で指定できる
TMP = os.environ.get("DUCKDB_TMP", os.path.join(tempfile.gettempdir(), "duckdb_tmp")).replace(chr(92), "/")

q = (
    "SELECT decode(value) v FROM parquet_kv_metadata('{}') "
    "WHERE CAST(key AS VARCHAR)='geo';".format(SRC)
)
out = subprocess.run(["duckdb", "-json", "-c", q], capture_output=True, text=True, check=True).stdout
geo = json.loads(out)[0]["v"]
json.loads(geo)  # 妥当な JSON か検証
assert "'" not in geo, "geo JSON にシングルクォートが含まれる (SQL 埋め込み不可)"

sql = f"""SET memory_limit='32GB';
SET temp_directory='{TMP}';
SET preserve_insertion_order=true;
COPY (SELECT * EXCLUDE (xyz) FROM '{SRC}')
TO '{DST}'
(FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9,
 ROW_GROUP_SIZE 1000000,
 KV_METADATA {{geo: '{geo}'}});
"""
with open(OUT, "w", encoding="utf-8") as f:
    f.write(sql)
print(f"wrote {OUT} (geo metadata: {len(geo)} bytes)")
