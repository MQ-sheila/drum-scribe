from __future__ import annotations

import functools
import faulthandler
import hashlib
import os
import pathlib
import sys
import tempfile
import threading
import traceback
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import webview
import omr_service
import update_service

webview.settings["ALLOW_DOWNLOADS"] = True

APP_ROOT = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))


class DesktopApi:
    def __init__(self, manager: update_service.UpdateManager):
        # pywebview recursively scans public attributes when exposing the JS
        # API. The window refers back to this object, so both must stay private.
        self._manager = manager
        self._window = None

    def update_status(self) -> dict:
        return self._manager.status()

    def check_for_updates(self) -> dict:
        return self._manager.check()

    def download_update(self) -> dict:
        return self._manager.start_download()

    def install_update(self) -> dict:
        result = self._manager.launch_install()
        if result["state"] == "installing" and self._window:
            threading.Timer(0.3, self._window.destroy).start()
        return result


def update_health_marker() -> pathlib.Path | None:
    prefix = "--update-health-marker="
    value = next((arg[len(prefix):] for arg in sys.argv[1:] if arg.startswith(prefix)), None)
    if not value:
        return None
    marker = pathlib.Path(value).resolve()
    allowed = pathlib.Path(os.environ["LOCALAPPDATA"]) / "DrumScribe" / "updates"
    return marker if marker.parent == allowed.resolve() and marker.name.startswith("health-") else None

class QuietStaticHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/runtime-config.js":
            port = self.server.backend_port
            body = f"window.DRUMSCRIBE_API_BASE = 'http://127.0.0.1:{port}';\n".encode("ascii")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self) -> None:
        # The desktop shell always uses the same localhost address. Without
        # explicit no-store headers WebView can keep an older index.html and
        # therefore run old extraction code after the EXE has been updated.
        self.send_header("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return

def serve(server: ThreadingHTTPServer) -> None:
    server.serve_forever(poll_interval=0.25)

def _mark_startup(log, stage: str) -> None:
    print(f"{datetime.now().isoformat(timespec='seconds')} pid={os.getpid()} {stage}",
          file=log, flush=True)


def _run_application(startup_log, data_dir: pathlib.Path) -> None:
    _mark_startup(startup_log, "starting")
    manager = update_service.UpdateManager(APP_ROOT, pathlib.Path(sys.executable).resolve().parent)
    desktop_api = DesktopApi(manager)
    health_marker = update_health_marker()
    static_handler = functools.partial(QuietStaticHandler, directory=str(APP_ROOT))
    # Fixed ports may be occupied or reserved by Windows even when no other
    # DrumScribe window is open. Ask the OS for two available loopback ports.
    omr_server = ThreadingHTTPServer(("127.0.0.1", 0), omr_service.RestrictedHandler)
    try:
        static_server = ThreadingHTTPServer(("127.0.0.1", 0), static_handler)
    except Exception:
        omr_server.server_close()
        raise
    static_server.backend_port = omr_server.server_port
    omr_service.ALLOWED_ORIGINS = frozenset({
        f"http://127.0.0.1:{static_server.server_port}",
    })
    for server in (static_server, omr_server):
        server.daemon_threads = True
        server.block_on_close = False
        threading.Thread(target=serve, args=(server,), daemon=True).start()
    _mark_startup(startup_log, "servers-ready")
    try:
        build_id = hashlib.sha256((APP_ROOT / "index.html").read_bytes()).hexdigest()[:12]
        window = webview.create_window(
            "DrumScribe",
            f"http://127.0.0.1:{static_server.server_port}/?desktop=1&build={build_id}",
            js_api=desktop_api,
            width=1440,
            height=920,
            min_size=(980, 680),
            resizable=True,
        )
        desktop_api._window = window
        def report_healthy() -> None:
            faulthandler.cancel_dump_traceback_later()
            _mark_startup(startup_log, "webview-loaded")
            if health_marker:
                health_marker.write_text("ready", encoding="ascii")
        window.events.loaded += report_healthy
        # A separate private WebView2 profile avoids a stale or locked shared
        # pywebview profile from blocking the UI and every Python HTTP thread.
        with tempfile.TemporaryDirectory(prefix="webview-", dir=data_dir,
                                         ignore_cleanup_errors=True) as profile_dir:
            _mark_startup(startup_log, "webview-starting")
            faulthandler.dump_traceback_later(20, file=startup_log)
            try:
                webview.start(gui="edgechromium", debug=False, private_mode=True,
                              storage_path=profile_dir)
            finally:
                faulthandler.cancel_dump_traceback_later()
                _mark_startup(startup_log, "webview-stopped")
    finally:
        # Closing the desktop window is also cancellation: stop Audiveris,
        # Tesseract, MuseScore conversion, and every descendant process first.
        omr_service.terminate_active_processes()
        static_server.shutdown()
        omr_server.shutdown()
        static_server.server_close()
        omr_server.server_close()
        omr_service.terminate_active_processes()


def main() -> None:
    data_dir = pathlib.Path(os.environ["LOCALAPPDATA"]) / "DrumScribe"
    data_dir.mkdir(parents=True, exist_ok=True)
    with (data_dir / "startup.log").open("a", encoding="utf-8", buffering=1) as log:
        faulthandler.enable(file=log, all_threads=True)
        try:
            _run_application(log, data_dir)
        except BaseException:
            traceback.print_exc(file=log)
            raise
        finally:
            faulthandler.disable()

if __name__ == "__main__":
    main()

