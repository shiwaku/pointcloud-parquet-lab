import sys, time, os
from qgis.core import (QgsApplication, QgsVectorLayer, QgsMapSettings, QgsMapRendererParallelJob,
                       QgsRectangle, QgsCoordinateReferenceSystem, QgsGraduatedSymbolRenderer, QgsClassificationEqualInterval,
                       QgsStyle, QgsMarkerSymbol)
from qgis.PyQt.QtCore import QSize
from qgis.PyQt.QtGui import QColor
# headless QGIS で GeoParquet を描画して時間を測る。
#   "C:/Program Files/QGIS 4.0.0/bin/python-qgis.bat" scripts/qgis_render.py data/09jc602_geoarrow.parquet out.png [xmin,ymin,xmax,ymax]
# 範囲の既定は 200 m 四方 (PCP テストと同じ)。標高 ($z) で 8 クラスに色分けする。
QgsApplication.setPrefixPath(os.environ.get("QGIS_PREFIX_PATH", r"C:\Program Files\QGIS 4.0.0\apps\qgis"), True)
app = QgsApplication([], False); app.initQgis()
path, out = sys.argv[1], sys.argv[2]
t = time.time()
lyr = QgsVectorLayer(path, "pc", "ogr")
print("valid", lyr.isValid(), "features", lyr.featureCount(), "crs", lyr.crs().authid(), "geom", lyr.wkbType(), "load", round(time.time()-t, 2), "s")
fields = [f.name() for f in lyr.fields()]; print("fields", fields[:8], "...")
# 標高で色分け (GeoArrow 版は z が geometry の中なので $z を使う)
sym = QgsMarkerSymbol.createSimple({"name": "circle", "size": "0.6", "outline_style": "no"})
ramp = QgsStyle.defaultStyle().colorRamp("Viridis")
r = QgsGraduatedSymbolRenderer("$z", [])
r.setSourceSymbol(sym); r.setSourceColorRamp(ramp); r.setClassificationMethod(QgsClassificationEqualInterval())
r.updateClasses(lyr, 8); lyr.setRenderer(r)
ms = QgsMapSettings(); ms.setLayers([lyr]); ms.setBackgroundColor(QColor(255, 255, 255))
ms.setDestinationCrs(QgsCoordinateReferenceSystem("EPSG:6677")); ms.setOutputSize(QSize(1200, 1200))
ext = [float(v) for v in sys.argv[3].split(",")] if len(sys.argv) > 3 else [-77200, 11000, -77000, 11200]
ms.setExtent(QgsRectangle(*ext))
t = time.time()
job = QgsMapRendererParallelJob(ms); job.start(); job.waitForFinished()
job.renderedImage().save(out)
print("render", ext, ":", round(time.time()-t, 1), "s ->", out)
app.exitQgis()
