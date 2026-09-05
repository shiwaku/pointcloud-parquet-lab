#!/usr/bin/env python3
"""GeoParquet 点群 (09jc602_geoarrow.parquet / 同 _overview.parquet) 用の QGIS スタイル (QML) を作る。

  "C:/Program Files/QGIS 4.0.0/bin/python-qgis.bat" scripts/make_qgis_styles.py [data/09jc602_geoarrow.parquet] [--step 10] [--styles elevation,rgb]

出力 (qgis/):
  geoarrow_elevation.qml  標高 ($z) を --step m 刻み (既定 10 m。境界は 10 の倍数に揃える) で色分け (Viridis)。
                          09jc602 (427.77〜877.93 m) では 420〜880 m の 46 段。
                          2D は段階色、3D は同じ段をルールベース 3D レンダラで Cube に割り当てる
  geoarrow_rgb.qml        2D は color_rgb("Red","Green","Blue") で点の色をそのまま出す。
                          3D はベクタレイヤの点シンボルに点ごとの色を付ける手段が無いので単色 (灰) の Cube
                          (3D で RGB を見たいなら COPC を点群レイヤで開く)

3D シンボルは高さの基準 (altitude clamping) を Absolute にしてジオメトリの z をそのまま使う。
3D のタイル分割は max-chunk-features を 5,000,000 にしてある (既定 1,000 のままだと点群は 3D に何も出ない)。
QML は QGIS の「レイヤ → プロパティ → スタイル → スタイルの読み込み」で当てる。3D 表示は
「ビュー → 3D マップビュー → 新規 3D マップビュー」。2.5 億点の本体を 3D に載せるのは無理なので、
1% サンプルか、範囲を絞った GeoParquet (200 m 四方 212 万点で約 1 分) に当てる。
"""
import argparse
import math
import os
import sys

from qgis.core import (
    QgsApplication, QgsVectorLayer, QgsGraduatedSymbolRenderer, QgsRendererRange, QgsSingleSymbolRenderer,
    QgsMarkerSymbol, QgsStyle, QgsProperty, QgsSymbolLayer, Qgis,
)
from qgis._3d import (QgsPoint3DSymbol, QgsPhongMaterialSettings, QgsRuleBased3DRenderer, QgsVectorLayer3DRenderer,
                      QgsVectorLayer3DTilingSettings)
from qgis.PyQt.QtGui import QColor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "qgis")
CUBE_SIZE = 0.3        # m。本体 (約 11 cm 間隔) では隙間が埋まり、1% サンプル (約 1 m 間隔) では点として見える
# 3D のタイル分割。既定の max-chunk-features=1000 だと、1 チャンクに 1,000 点を超える点群は 3D に何も描かれない
# (QGIS 4.0.0 で確認。エラーも出ない)。点群では必ず超えるので大きくする。zoom-levels-count は既定の 3
MAX_CHUNK_FEATURES = 5_000_000
ZOOM_LEVELS = 3


def marker(color=None, size_mm=0.6):
    sym = QgsMarkerSymbol.createSimple({"name": "circle", "size": str(size_mm), "outline_style": "no"})
    if color is not None:
        sym.setColor(color)
    return sym


def cube(color):
    s = QgsPoint3DSymbol()
    s.setShape(QgsPoint3DSymbol.Cube)
    s.setShapeProperties({"size": CUBE_SIZE})
    s.setAltitudeClamping(Qgis.AltitudeClamping.Absolute)
    m = QgsPhongMaterialSettings()
    m.setDiffuse(color)
    m.setAmbient(color.darker(150))
    m.setSpecular(QColor(40, 40, 40))
    m.setShininess(0)
    s.setMaterialSettings(m)
    return s


def tiling():
    t = QgsVectorLayer3DTilingSettings()
    t.setZoomLevelsCount(ZOOM_LEVELS)
    t.setMaximumChunkFeatures(MAX_CHUNK_FEATURES)
    t.setShowBoundingBoxes(False)
    return t


def z_range(layer):
    ext = layer.extent3D() if hasattr(layer, "extent3D") else None
    if ext is not None and ext.zMinimum() < ext.zMaximum():
        return ext.zMinimum(), ext.zMaximum()
    # 統計が取れなければ 09jc602 の実測値
    return 427.77, 877.93


def elevation_style(layer, zmin, zmax, step):
    """zmin〜zmax を step m 刻みで分ける。境界は step の倍数に揃える (430, 440, …)"""
    ramp = QgsStyle.defaultStyle().colorRamp("Viridis")
    lo0 = math.floor(zmin / step) * step
    n = int(math.ceil((zmax - lo0) / step))
    ranges = []
    rules = QgsRuleBased3DRenderer.Rule(None)
    for i in range(n):
        lo, hi = lo0 + i * step, lo0 + (i + 1) * step
        color = ramp.color((i + 0.5) / n)
        label = f"{lo:g} - {hi:g} m"
        ranges.append(QgsRendererRange(lo, hi, marker(color), label))
        rule = QgsRuleBased3DRenderer.Rule(cube(color), f'$z >= {lo:g} AND $z {"<=" if i == n - 1 else "<"} {hi:g}', label)
        rules.appendChild(rule)
    print(f"elevation: {n} classes, {lo0:g}..{lo0 + n * step:g} m, step {step:g} m")
    r2d = QgsGraduatedSymbolRenderer("$z", ranges)
    r2d.setSourceSymbol(marker())
    r2d.setSourceColorRamp(ramp)
    r2d.setGraduatedMethod(Qgis.GraduatedMethod.Color)
    layer.setRenderer(r2d)
    r3d = QgsRuleBased3DRenderer(rules)
    r3d.setTilingSettings(tiling())
    layer.setRenderer3D(r3d)


def rgb_style(layer):
    sym = marker(QColor(200, 200, 200))
    sym.symbolLayer(0).setDataDefinedProperty(
        QgsSymbolLayer.Property.FillColor, QgsProperty.fromExpression('color_rgb("Red", "Green", "Blue")'))
    layer.setRenderer(QgsSingleSymbolRenderer(sym))
    r3d = QgsVectorLayer3DRenderer(cube(QColor(190, 190, 190)))
    r3d.setTilingSettings(tiling())
    layer.setRenderer3D(r3d)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", default="data/09jc602_geoarrow.parquet")
    ap.add_argument("--step", type=float, default=10.0, help="標高の刻み (m)。既定 10")
    ap.add_argument("--styles", default="elevation,rgb", help="作るスタイル (カンマ区切り)。既定 elevation,rgb")
    args = ap.parse_args()
    path = args.input
    styles = [x.strip() for x in args.styles.split(",") if x.strip()]
    QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", r"C:\Program Files\QGIS 4.0.0\apps\qgis"), True)
    app = QgsApplication([], False)
    app.initQgis()
    layer = QgsVectorLayer(path, "pc", "ogr")
    if not layer.isValid():
        sys.exit(f"開けない: {path}")
    zmin, zmax = z_range(layer)
    print(f"{path}: {layer.featureCount():,} features, z {zmin:.2f}..{zmax:.2f}")
    os.makedirs(OUT_DIR, exist_ok=True)

    if "elevation" in styles:
        elevation_style(layer, zmin, zmax, args.step)
        out = os.path.join(OUT_DIR, "geoarrow_elevation.qml")
        msg, ok = layer.saveNamedStyle(out)
        print(("saved " if ok else "FAILED ") + out, msg if not ok else "")
    if "rgb" in styles:
        rgb_style(layer)
        out = os.path.join(OUT_DIR, "geoarrow_rgb.qml")
        msg, ok = layer.saveNamedStyle(out)
        print(("saved " if ok else "FAILED ") + out, msg if not ok else "")
    app.exitQgis()


if __name__ == "__main__":
    main()
