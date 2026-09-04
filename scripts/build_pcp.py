#!/usr/bin/env python3
"""GeoArrow GeoParquet → PCP (Point Cloud Parquet) 変換。

PCP は https://kanahiro.github.io/pcp/ が読む点群 Parquet のレイアウト。
仕様書は公開されていないので、ビューアの worker (point-cloud.worker-*.js) と
デモファイル (cogp-demo.spatialty.io/temp/114112.parquet) から読み取った要件で作る:

  * 列 x, y, z は INT32 の量子化座標。world = q * scale + offset
  * 列 red, green, blue は UINT16 (0..65535)。(0,0,0) は「色なし」扱い
  * row group は LOD レベル順 (粗 → 細) に並び、レベル境界をまたがない
  * 各 row group の x/y/z に min/max 統計が必要 (bbox による枝刈りに使う)
  * footer の key_value_metadata に "point_cloud" (JSON):
      version "0.1.0", scale[3], offset[3], bounds[6] (world),
      level_row_group_ends[] (レベルごとの row group 終端インデックス、累積),
      base_voxel_size, coarsest_voxel_size, hierarchy (文字列), spatial_order (文字列)
    レベル k のボクセル 1 辺 = coarsest_voxel_size / 2^k、幾何誤差 = ボクセル 1 辺 × √3

使い方 (リポジトリルートで):
  python scripts/build_pcp.py data/09jc602_geoarrow.parquet data/09jc602_pcp.parquet
  python scripts/build_pcp.py IN OUT --where "geometry.x BETWEEN -77200 AND -77000 AND geometry.y BETWEEN 11000 AND 11200"

段階:
  1. DuckDB (scripts/pcp_sort.sql) で量子化・Morton 順ソート・レベル割り当て → <OUT>.sorted.parquet
  2. pyarrow で level ごとに row group を切り直し、point_cloud メタデータを付けて <OUT> に書く
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_TEMPLATE = os.path.join(HERE, "pcp_sort.sql")

SCALE = 0.01                 # LAS と同じ 0.01 m 格子
COARSEST_SHIFT = 12          # レベル 0 のボクセル = 2^12 格子単位 = 40.96 m
N_VOXEL_LEVELS = 10          # 40.96, 20.48, ... 0.08 m の 10 段。11 段目は余り
CRS = "EPSG:6677"

# 出力スキーマ (デモファイルの列名・型に合わせる。LAS 1.2 PDRF3 に無い列は省く)
SCHEMA = pa.schema([
    ("x", pa.int32()), ("y", pa.int32()), ("z", pa.int32()),
    ("red", pa.uint16()), ("green", pa.uint16()), ("blue", pa.uint16()),
    ("intensity", pa.uint16()),
    ("return_number", pa.uint8()), ("number_of_returns", pa.uint8()),
    ("scan_direction_flag", pa.bool_()), ("edge_of_flight_line", pa.bool_()),
    ("classification", pa.uint8()),
    ("synthetic", pa.bool_()), ("key_point", pa.bool_()), ("withheld", pa.bool_()), ("overlap", pa.bool_()),
    ("scan_angle", pa.int16()), ("user_data", pa.uint8()), ("point_source_id", pa.uint16()),
    ("gps_time", pa.float64()),
])
NO_DICT = {"x", "y", "z", "gps_time"}   # 座標は DELTA_BINARY_PACKED、時刻は BYTE_STREAM_SPLIT
# 既定で落とす列。gps_time は Morton 順に並べ替えると連続性を失って圧縮が効かず (0.99 GB, 全体の 30%)、
# PCP は読まない。--keep-columns gps_time で残せる
DEFAULT_DROP = ["gps_time"]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def stage1_sort(args, sorted_path):
    """DuckDB で量子化 + Morton ソート + レベル割り当て"""
    con = duckdb.connect()
    con.execute(f"SET threads = {args.threads}")
    (xmin, ymin, zmin, xmax, ymax, zmax) = con.execute(f"""
        SELECT min(round(geometry.x / {SCALE}))::BIGINT, min(round(geometry.y / {SCALE}))::BIGINT, min(round(geometry.z / {SCALE}))::BIGINT,
               max(round(geometry.x / {SCALE}))::BIGINT, max(round(geometry.y / {SCALE}))::BIGINT, max(round(geometry.z / {SCALE}))::BIGINT
        FROM read_parquet('{args.input}') WHERE {args.where}""").fetchone()
    con.close()
    log(f"quantized bounds: x {xmin}..{xmax}  y {ymin}..{ymax}  z {zmin}..{zmax}")
    for name, lo, hi in (("x", xmin, xmax), ("y", ymin, ymax), ("z", zmin, zmax)):
        if hi - lo >= 1 << 18:
            sys.exit(f"{name} の範囲 {hi - lo} 格子単位が 18 bit (262144) を超える。SCALE か Morton のビット数を見直すこと")

    spread3 = " | ".join(f"(((v >> {i}) & 1) << {3 * i})" for i in range(18))
    level_cases = " ".join(
        f"WHEN (d >> {3 * (COARSEST_SHIFT - k)}) != 0 THEN {k}" for k in range(N_VOXEL_LEVELS)
    )
    sql = open(SQL_TEMPLATE, encoding="utf-8").read().format(
        THREADS=args.threads, MEMORY=args.memory, TMP=args.tmp.replace("\\", "/"),
        SPREAD3=spread3, INV_SCALE=round(1 / SCALE), INPUT=args.input.replace("\\", "/"),
        WHERE=args.where, XMIN=xmin, YMIN=ymin, ZMIN=zmin,
        LEVEL_CASES=level_cases, REMAINDER_LEVEL=N_VOXEL_LEVELS,
        OUTPUT=sorted_path.replace("\\", "/"),
    )
    sql_path = args.output + ".sql"
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write(sql)
    os.makedirs(args.tmp, exist_ok=True)
    log(f"stage 1: DuckDB sort → {sorted_path}  (SQL: {sql_path})")
    t0 = time.time()
    # CLI を使う (進捗バーが出る)。Python API でも同じ SQL が動く
    subprocess.run(["duckdb", "-c", f".read {sql_path}"], check=True)
    log(f"stage 1 done in {time.time() - t0:.0f} s")
    return (xmin, ymin, zmin, xmax, ymax, zmax)


def stage2_write(args, sorted_path, qbounds):
    """レベル境界に揃えた row group で書き直し、point_cloud メタデータを付ける"""
    rgs = args.row_group_size
    con = duckdb.connect()
    level_counts = dict(con.execute(
        f"SELECT level, count(*) FROM read_parquet('{sorted_path}') GROUP BY level ORDER BY level").fetchall())
    con.close()
    n_levels = N_VOXEL_LEVELS + 1
    counts = [int(level_counts.get(k, 0)) for k in range(n_levels)]
    ends, acc = [], 0
    for c in counts:
        acc += math.ceil(c / rgs)
        ends.append(acc)
    total = sum(counts)
    log("points per level: " + ", ".join(f"L{k}={c:,}" for k, c in enumerate(counts)) + f"  (total {total:,})")
    log(f"row groups per level end: {ends}")

    xmin, ymin, zmin, xmax, ymax, zmax = qbounds
    meta = {
        "version": "0.1.0",
        "scale": [SCALE, SCALE, SCALE],
        "offset": [0.0, 0.0, 0.0],
        "bounds": [xmin * SCALE, ymin * SCALE, zmin * SCALE, xmax * SCALE, ymax * SCALE, zmax * SCALE],
        "level_row_group_ends": ends,
        "base_voxel_size": SCALE,
        "coarsest_voxel_size": SCALE * (1 << COARSEST_SHIFT),
        "hierarchy": "additive_voxel_first",
        "spatial_order": "morton_3d_row_group",
        "source_las": {"point_format": 3, "extra_bytes_per_point": 0, "scan_angle_scale": 1.0},
        "crs": CRS,
        "source": os.path.basename(args.input),
    }
    drop = [c for c in args.drop if c not in args.keep_columns]
    if any(c in drop for c in ("x", "y", "z", "red", "green", "blue")):
        sys.exit("x/y/z/red/green/blue は PCP が必須とするので落とせない")
    out_fields = [f for f in SCHEMA if f.name not in drop]
    out_names = [f.name for f in out_fields]
    if drop:
        log(f"dropping columns: {drop}")
    schema = pa.schema(out_fields).with_metadata({"point_cloud": json.dumps(meta, separators=(",", ":"))})
    encodings = {"x": "DELTA_BINARY_PACKED", "y": "DELTA_BINARY_PACKED", "z": "DELTA_BINARY_PACKED",
                 "gps_time": "BYTE_STREAM_SPLIT"}
    log(f"stage 2: writing {args.output}  (row group size {rgs})")
    t0 = time.time()
    writer = pq.ParquetWriter(
        args.output, schema,
        compression="zstd",
        use_dictionary=[n for n in out_names if n not in NO_DICT],
        column_encoding={k: v for k, v in encodings.items() if k in out_names},
        write_statistics=True,
        write_page_index=True,
        version="2.6",
    )
    pf = pq.ParquetFile(sorted_path)
    cols = out_names + ["level"]
    buf, buf_level, written_per_level = [], None, [0] * n_levels

    def flush(final=False):
        nonlocal buf
        if not buf:
            return
        tbl = pa.concat_tables(buf) if len(buf) > 1 else buf[0]
        while tbl.num_rows >= rgs or (final and tbl.num_rows > 0):
            n = min(rgs, tbl.num_rows)
            writer.write_table(tbl.slice(0, n).select(out_names).cast(schema), row_group_size=n)
            written_per_level[buf_level] += 1
            tbl = tbl.slice(n)
        buf = [tbl] if tbl.num_rows else []

    done = 0
    for batch in pf.iter_batches(batch_size=rgs, columns=cols):
        levels = batch.column("level").to_numpy()
        cuts = np.flatnonzero(np.diff(levels)) + 1
        for piece in np.split(np.arange(len(levels)), cuts):
            lv = int(levels[piece[0]])
            if buf_level is not None and lv != buf_level:
                flush(final=True)            # レベルが変わる: 端数も row group として閉じる
            buf_level = lv
            buf.append(pa.Table.from_batches([batch.slice(piece[0], len(piece))]))
            flush()
        done += batch.num_rows
        if done % (rgs * 200) < rgs:
            log(f"  {done:,} / {total:,} points  ({100 * done / total:.0f} %)")
    flush(final=True)
    writer.close()
    log(f"stage 2 done in {time.time() - t0:.0f} s")

    got_ends = list(np.cumsum(written_per_level))
    if got_ends != ends:
        sys.exit(f"row group 数が見積りと一致しない: 書き込み {got_ends} / メタデータ {ends}")


def verify(path):
    pf = pq.ParquetFile(path)
    md = pf.metadata
    kv = md.metadata or {}
    pc = json.loads(kv[b"point_cloud"])
    size = os.path.getsize(path)
    footer = md.serialized_size
    log(f"verify: {path}")
    log(f"  {md.num_rows:,} points, {md.num_row_groups} row groups, {size / 1e6:,.0f} MB, footer {footer / 1e6:.1f} MB")
    log(f"  levels {len(pc['level_row_group_ends'])}, ends {pc['level_row_group_ends']}")
    log(f"  bounds {pc['bounds']}")
    assert pc["level_row_group_ends"][-1] == md.num_row_groups
    idx = {name: i for i, name in enumerate(pf.schema_arrow.names)}
    for rg in (0, md.num_row_groups - 1):
        r = md.row_group(rg)
        st = [r.column(idx[c]).statistics for c in ("x", "y", "z")]
        assert all(s is not None and s.has_min_max for s in st), f"row group {rg} に x/y/z の統計が無い"
        log(f"  rg {rg}: {r.num_rows:,} rows, x {st[0].min}..{st[0].max}, y {st[1].min}..{st[1].max}, z {st[2].min}..{st[2].max}")
    # 全 row group の x/y/z 統計が揃っているか
    missing = [rg for rg in range(md.num_row_groups)
               if not all(md.row_group(rg).column(idx[c]).statistics.has_min_max for c in ("x", "y", "z"))]
    assert not missing, f"統計が無い row group: {missing[:10]}"
    log("  OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--where", default="TRUE", help="入力を絞る SQL 条件 (テスト用)")
    ap.add_argument("--row-group-size", type=int, default=65536)
    ap.add_argument("--drop", nargs="*", default=DEFAULT_DROP, help=f"出力から落とす列 (既定 {DEFAULT_DROP})")
    ap.add_argument("--keep-columns", nargs="*", default=[], help="--drop の既定から残したい列 (例: gps_time)")
    ap.add_argument("--threads", type=int, default=16)
    # 物理メモリ (64 GB) の空きより大きくすると DuckDB が "Out of Memory Error: Allocation failure" で落ちる
    # (他のプロセスが数 GB 使っている状態で 40GB 指定が失敗した)。超えた分は temp_directory に退避される
    ap.add_argument("--memory", default="24GB")
    ap.add_argument("--tmp", default="C:/mm/duckdb_tmp", help="DuckDB の spill 先 (短いパスにする)")
    ap.add_argument("--skip-sort", action="store_true", help="<OUT>.sorted.parquet が既にあるなら段階 1 を飛ばす")
    ap.add_argument("--keep-sorted", action="store_true", help="中間ファイルを消さない")
    args = ap.parse_args()

    sorted_path = args.output + ".sorted.parquet"
    if args.skip_sort and os.path.exists(sorted_path):
        con = duckdb.connect()
        qbounds = con.execute(
            f"SELECT min(x), min(y), min(z), max(x), max(y), max(z) FROM read_parquet('{sorted_path}')").fetchone()
        con.close()
        log(f"stage 1 skipped, reusing {sorted_path}")
    else:
        qbounds = stage1_sort(args, sorted_path)
    stage2_write(args, sorted_path, qbounds)
    verify(args.output)
    if not args.keep_sorted:
        os.remove(sorted_path)
        log(f"removed {sorted_path}")


if __name__ == "__main__":
    main()
