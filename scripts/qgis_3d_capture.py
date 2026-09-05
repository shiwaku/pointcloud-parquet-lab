# QGIS デスクトップを起動して 3D マップビューを開き、QML を当てた GeoParquet を画面キャプチャする (動作確認用)。
#   "C:/Program Files/QGIS 4.0.0/bin/qgis.bat" --nologo --noplugins --code scripts/qgis_3d_capture.py
# 環境変数 CAPTURE_DIR に出力先。QGIS のウィンドウが開き、約 2 分で自動終了する。
# python-qgis.bat (headless) では 3D をオフスクリーン描画できない (QGIS 4.0 の Python に QgsOffscreen3DEngine が無い) ので、
# デスクトップを --code で動かして 3D キャンバスの QWindow をスクリーンから取る。
import os, traceback, time
from qgis.core import QgsProject, QgsVectorLayer, QgsCoordinateReferenceSystem, QgsVector3D, QgsApplication
from qgis.PyQt import sip
from qgis.PyQt.QtCore import QTimer
from qgis.PyQt.QtWidgets import QApplication, QAction
from qgis.PyQt.QtGui import QGuiApplication
from qgis._3d import Qgs3DMapCanvas
from qgis.utils import iface
ROOT = r"C:\Users\yshiw\Documents\GIS\pointcloud-parquet-lab"
OUT = os.environ.get("CAPTURE_DIR", ROOT)
MID = ROOT + r"\data\09jc602_geoarrow_200m.parquet"
log = open(os.path.join(OUT, "final.log"), "w", encoding="utf-8")
def L(*a): print(time.strftime("%H:%M:%S"), *a, file=log, flush=True)
state = {}
def guarded(fn):
    def w():
        try: fn()
        except Exception:
            L("EXC in", fn.__name__, traceback.format_exc()); finish()
    return w
def canvas3d():
    ws = [w for w in QGuiApplication.allWindows() if "3DMapCanvas" in w.metaObject().className()]
    return sip.cast(ws[0], Qgs3DMapCanvas) if ws else None
def grab(name):
    c = canvas3d(); img = c.screen().grabWindow(c.winId()); img.save(os.path.join(OUT, name)); L("saved", name)
@guarded
def step1():
    lyr = QgsVectorLayer(MID, "geoparquet 200m", "ogr")
    msg, ok = lyr.loadNamedStyle(ROOT + r"\qgis\geoarrow_elevation.qml")
    L("layer", lyr.isValid(), lyr.featureCount(), "qml", ok, "3D", lyr.renderer3D().type())
    QgsProject.instance().addMapLayer(lyr); QgsProject.instance().setCrs(QgsCoordinateReferenceSystem("EPSG:6677")); state["lyr"] = lyr
    iface.mapCanvas().setExtent(lyr.extent()); iface.mapCanvas().refresh()
    QTimer.singleShot(6000, step2)
@guarded
def step2():
    iface.mainWindow().findChild(QAction, "mActionNew3DMapCanvas").trigger()
    QTimer.singleShot(8000, step3)
@guarded
def step3():
    for w in QApplication.topLevelWidgets():
        if w.isVisible() and w is not iface.mainWindow() and "3D" in w.windowTitle(): w.resize(1300, 900); w.move(40, 40)
    c = canvas3d(); L("3D extent", c.mapSettings().extent().toString())
    c.mapSettings().setLayers([state["lyr"]])
    c.cameraController().setLookingAtMapPoint(QgsVector3D(-77100, 11100, 750), 360, 45, 30)
    state["t0"] = time.time(); L("camera set, waiting")
    QTimer.singleShot(30000, step4)
@guarded
def step4():
    grab("final_elevation_3d_30s.png")
    QTimer.singleShot(60000, step5)
@guarded
def step5():
    grab("final_elevation_3d_90s.png")
    c = canvas3d(); c.cameraController().setLookingAtMapPoint(QgsVector3D(-77120, 11080, 740), 120, 35, 60); L("camera close")
    QTimer.singleShot(20000, step6)
@guarded
def step6():
    grab("final_elevation_3d_close.png"); finish()
def finish():
    QgsProject.instance().setDirty(False); L("quit"); log.close()
    QTimer.singleShot(1000, QApplication.instance().quit); QTimer.singleShot(6000, lambda: os._exit(0))
QTimer.singleShot(3000, step1)
