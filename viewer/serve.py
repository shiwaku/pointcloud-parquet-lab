#!/usr/bin/env python3
"""Range request 対応の静的ファイルサーバ。

`python -m http.server` は Range ヘッダを無視して全体を返すため、
hyparquet が Parquet の footer や row group だけを部分読みできない。
このサーバはプロジェクトルート (このファイルの 1 つ上) を配信し、
Range / HEAD / CORS に対応する。

使い方 (プロジェクトルートで):
    python viewer/serve.py            # http://127.0.0.1:8080/viewer/
    python viewer/serve.py 9000       # ポート指定
"""
import os
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive。row group ごとに数本の range request が飛ぶので接続を使い回す
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".parquet": "application/vnd.apache.parquet",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def __init__(self, *args, **kwargs):
        self.range_length = None
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_head(self):
        self.range_length = None
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()

        size = os.path.getsize(path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if not m or (m.group(1) == "" and m.group(2) == ""):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        if m.group(1) == "":  # suffix range: bytes=-N
            start = max(0, size - int(m.group(2)))
            end = size - 1
        else:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        f = open(path, "rb")
        f.seek(start)
        self.range_length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.range_length))
        self.send_header("Last-Modified", self.date_time_string(os.stat(path).st_mtime))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        if self.range_length is None:
            return super().copyfile(source, outputfile)
        remaining = self.range_length
        try:
            while remaining > 0:
                chunk = source.read(min(1 << 20, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass  # ブラウザ側が途中で切った (視点移動で不要になった要求)。正常動作

    def log_request(self, code="-", size="-"):
        # 部分読みのアクセスは数千回に及ぶので、成功ログは既定では出さない (SERVE_LOG=1 で全件)
        if isinstance(code, int) and code < 400 and not os.environ.get("SERVE_LOG"):
            return
        rng = self.headers.get("Range", "")
        sys.stderr.write(f"{time.strftime('%H:%M:%S')} {threading.get_ident() % 10000:04d} "
                         f"{self.command} {self.path} {rng} -> {code}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), RangeHandler)
    print(f"serving {ROOT}")
    print(f"viewer: http://127.0.0.1:{port}/viewer/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
