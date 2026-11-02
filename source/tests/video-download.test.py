"""Downloader dispatch and byte-range serving without network access."""

import io
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer


project = Path(__file__).resolve().parents[2]
os.environ["LOCALAPPDATA"] = str(project / ".build" / "video-download-test-data")
sys.path.insert(0, str(project / "source"))
import video_download  # noqa: E402
import omr_service  # noqa: E402


def wait_for(job_id):
    for _ in range(100):
        result = video_download.status(job_id)[1]
        if result["state"] in {"done", "error", "cancelled"}:
            return result
        time.sleep(.02)
    raise AssertionError("download task did not finish")


class FakeYdl:
    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _url, download):
        assert download
        target = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
        target.write_bytes(b"0123456789")
        self.options["progress_hooks"][0]({
            "status": "downloading", "downloaded_bytes": 5, "total_bytes": 10,
        })
        return {"title": "示例视频"}


class VideoDownloadTest(unittest.TestCase):
    def test_provider_and_share_text(self):
        self.assertEqual(video_download.parse_video_link(
            "看这个 https://www.bilibili.com/video/BV123?p=2"),
            ("https://www.bilibili.com/video/BV123?p=2", "bilibili"))
        self.assertEqual(video_download.parse_video_link(
            "https://www.youtube.com/watch?v=123")[1], "yt-dlp")
        self.assertEqual(video_download.parse_video_link(
            "https://v.douyin.com/abc")[1], "yt-dlp")
        self.assertEqual(video_download.parse_video_link(
            "https://xhslink.com/abc")[1], "yt-dlp")
        for url in ("http://127.0.0.1/private",):
            with self.assertRaises(ValueError):
                video_download.parse_video_link(url)

    def test_generic_download_and_range(self):
        with patch.object(video_download, "YoutubeDL", FakeYdl):
            code, started = video_download.start("https://example.com/video")
            self.assertEqual(code, 200)
            result = wait_for(started["id"])
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["provider"], "yt-dlp")
        self.assertEqual(result["fileUrl"],
                         f"/api/video-download/file?job={started['id']}")

        class Handler:
            headers = {"Range": "bytes=2-5"}
            wfile = io.BytesIO()
            response = None
            sent_headers = {}

            def send_response(self, code):
                self.response = code

            def send_header(self, key, value):
                self.sent_headers[key] = value

            def end_headers(self):
                pass

            def _request_origin(self):
                return "http://127.0.0.1:8765"

        handler = Handler()
        video_download.stream_file(handler, started["id"])
        self.assertEqual(handler.response, 206)
        self.assertEqual(handler.wfile.getvalue(), b"2345")
        self.assertEqual(handler.sent_headers["Content-Range"], "bytes 2-5/10")

        origin = "http://127.0.0.1:8765"
        omr_service.ALLOWED_ORIGINS = frozenset({origin})
        server = ThreadingHTTPServer(("127.0.0.1", 0), omr_service.RestrictedHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            request = Request(
                f"http://127.0.0.1:{server.server_port}{result['fileUrl']}",
                headers={"Origin": origin, "Range": "bytes=2-5"})
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
                self.assertEqual(response.read(), b"2345")
        finally:
            server.shutdown()
            server.server_close()

    def test_bilibili_uses_its_own_downloader(self):
        def fake_bbdown(job):
            (job["folder"] / "video.mp4").write_bytes(b"bili")

        with patch.object(video_download, "_bbdown_download", fake_bbdown), \
             patch.object(video_download, "YoutubeDL", side_effect=AssertionError):
            code, started = video_download.start(
                "https://www.bilibili.com/video/BV123")
            self.assertEqual(code, 200)
            result = wait_for(started["id"])
        self.assertEqual(result["state"], "done")
        self.assertEqual(result["provider"], "bilibili")


if __name__ == "__main__":
    unittest.main()
