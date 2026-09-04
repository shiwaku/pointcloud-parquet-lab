"""ALP (FOR + bit-packing, 1024 値ブロック) の理論サイズを int32 スケール座標から見積もる。
Parquet 用 ALP の実装がまだ無いので、仕様どおりのブロック単位 FOR ビット幅を数える。
比較として DELTA (前の値との差分) の同じブロック単位ビット幅も出す。
実行 (リポジトリルートで): python experiments/alp/alp_estimate.py
"""
import numpy as np
import pyarrow.parquet as pq

N_BLOCK = 1024
t = pq.read_table("data/09jc602_int32_v1.parquet", columns=["xi", "yi", "zi"])
n = t.num_rows
print(f"points: {n:,}")

def bits_for(v):
    """ブロックごとの (max-min) に必要なビット幅の合計 [bit]"""
    m = (len(v) // N_BLOCK) * N_BLOCK
    b = v[:m].reshape(-1, N_BLOCK).astype(np.int64)
    rng = b.max(axis=1) - b.min(axis=1)
    w = np.where(rng > 0, np.floor(np.log2(np.maximum(rng, 1))) + 1, 0)
    return (w * N_BLOCK).sum() + rng.size * 64  # 基準値 (8 B/ブロック) を足す

tot_for = tot_delta = 0
for c in ["xi", "yi", "zi"]:
    v = t.column(c).to_numpy()
    f = bits_for(v)
    d = bits_for(np.diff(v, prepend=v[0]))
    tot_for += f; tot_delta += d
    print(f"{c}: FOR {f/8/n:.2f} B/pt  DELTA+FOR {d/8/n:.2f} B/pt")
print(f"xyz 合計: ALP(FOR) {tot_for/8/1e9:.2f} GB = {tot_for/8/n:.2f} B/pt,  DELTA {tot_delta/8/1e9:.2f} GB = {tot_delta/8/n:.2f} B/pt")
