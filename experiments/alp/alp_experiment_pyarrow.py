"""ALP を模した Parquet エンコード実験 (pyarrow)。DuckDB 1.1.3 は PARQUET_VERSION V2 未対応なので pyarrow で書く。

  B: int32 座標 (LAS と同じ ×100 スケール値) を DELTA_BINARY_PACKED + ZSTD
  C: double 座標を BYTE_STREAM_SPLIT + ZSTD (ALP 無しの double 格納の現実的な上限)

いずれも有効な GeoParquet ではない (geo メタデータ無し)。サイズ比較のみが目的。
実行 (リポジトリルートで): python experiments/alp/alp_experiment_pyarrow.py        (B と C)
      python experiments/alp/alp_experiment_pyarrow.py C      (C のみ)
      python experiments/alp/alp_experiment_pyarrow.py D      (D のみ)
"""
import time
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

ATTRS = ["Intensity", "ReturnNumber", "NumberOfReturns", "ScanDirectionFlag", "EdgeOfFlightLine",
         "Classification", "Synthetic", "KeyPoint", "Withheld", "Overlap", "ScanAngleRank", "UserData",
         "PointSourceId", "GpsTime", "Red", "Green", "Blue"]

def write(src, dst, transform, encodings):
    t0 = time.time()
    pf = pq.ParquetFile(src)
    writer = None
    for i in range(pf.num_row_groups):
        tbl = transform(pf.read_row_group(i))
        if writer is None:
            writer = pq.ParquetWriter(dst, tbl.schema, compression="zstd",
                                      use_dictionary=False, column_encoding=encodings,
                                      data_page_version="2.0", write_statistics=True)
        writer.write_table(tbl, row_group_size=1_000_000)
    writer.close()
    print(f"{dst}: {time.time()-t0:.0f} s", flush=True)

# B: int32 座標 + DELTA_BINARY_PACKED
enc_b = {c: "DELTA_BINARY_PACKED" for c in ["xi", "yi", "zi"]}
enc_b["GpsTime"] = "BYTE_STREAM_SPLIT"
import os, sys
if len(sys.argv) == 1:
    write("data/09jc602_int32_v1.parquet", "data/09jc602_int32_delta.parquet", lambda t: t, enc_b)

# C: double 座標 + BYTE_STREAM_SPLIT (struct を平坦化)
def flatten(t):
    g = t.column("geometry")
    cols = {k: pc.struct_field(g, k) for k in ("x", "y", "z")}
    for a in ATTRS:
        cols[a] = t.column(a)
    return pa.table(cols)
enc_c = {c: "BYTE_STREAM_SPLIT" for c in ["x", "y", "z", "GpsTime"]}
if len(sys.argv) == 1 or sys.argv[1] == "C":
    write("data/09jc602_geoarrow.parquet", "data/09jc602_double_bss.parquet", flatten, enc_c)

# D: B の座標エンコードに、属性列は辞書エンコード (GDAL 版と同等) を組み合わせた「今の Parquet で最小」を狙う版
if len(sys.argv) > 1 and sys.argv[1] == "D":
    t0 = time.time()
    pf = pq.ParquetFile("data/09jc602_int32_v1.parquet")
    dict_cols = [a for a in ATTRS if a != "GpsTime"]
    writer = None
    for i in range(pf.num_row_groups):
        tbl = pf.read_row_group(i)
        if writer is None:
            writer = pq.ParquetWriter("data/09jc602_int32_delta_dict.parquet", tbl.schema, compression="zstd",
                                      use_dictionary=dict_cols, column_encoding=enc_b,
                                      data_page_version="2.0", write_statistics=True)
        writer.write_table(tbl, row_group_size=1_000_000)
    writer.close()
    print(f"09jc602_int32_delta_dict.parquet: {time.time()-t0:.0f} s", flush=True)
