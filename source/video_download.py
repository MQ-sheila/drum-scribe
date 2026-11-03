"""One-at-a-time video downloads for the local DrumScribe interface."""

from __future__ import annotations

import atexit
import ipaddress
import mimetypes
import os
import pathlib
import re
import secrets
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlparse

from yt_dlp import YoutubeDL


ROOT = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home())) / "DrumScribe"
DOWNLOADS = ROOT / "video_downloads"
DOWNLOADS.mkdir(parents=True, exist_ok=True)
APP_ROOT = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_BARE_URL = re.compile(r"(?<![\w@./-])(?:[a-z0-9-]+\.)+[a-z]{2,}/[^\s<>\"']+", re.IGNORECASE)
_JOBS: dict[str, dict] = {}
_LOCK = threading.RLock()
_ACTIVE: str | None = None
_BILI_HOSTS = ("bilibili.com", "b23.tv")
_VIDEO_EXTENSIONS = {".mp4", ".webm", ".mkv", ".mov", ".m4v"}


def _host_matches(host: str, suffixes: tuple[str, ...]) -> bool:
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def parse_video_link(text: str) -> tuple[str, str]:
    """Accept a URL or a copied share sentence containing one URL."""
    if not isinstance(text, str) or len(text) > 4096:
        raise ValueError("请粘贴一个视频链接")
    match = _URL.search(text)
    bare = _BARE_URL.search(text) if not match else None
    if not match and not bare:
        raise ValueError("没有找到视频链接")
    url = ((match.group() if match else "https://" + bare.group())
           .rstrip(".,;!?，。；！？)]}）"))
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
        raise ValueError("视频链接格式不正确")
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("请输入公开视频网站的链接")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("请输入公开视频网站的链接")
    return url, "bilibili" if _host_matches(host, _BILI_HOSTS) else "yt-dlp"


def _update(job: dict, **fields: object) -> None:
    with _LOCK:
        job.update(fields)


def _check_cancel(job: dict) -> None:
    if job["cancel"].is_set():
        raise RuntimeError("下载已取消")


def _yt_dlp_download(job: dict) -> None:
    folder: pathlib.Path = job["folder"]

    def progress(data: dict) -> None:
        _check_cancel(job)
        downloaded = int(data.get("downloaded_bytes") or 0)
        total = int(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
        percent = round(downloaded * 100 / total, 1) if total else 0
        _update(job, state="downloading", percent=percent,
                detail=f"正在下载 {percent:.1f}%" if total else "正在下载视频")

    options = {
        "outtmpl": str(folder / "video.%(ext)s"),
        "format": "bv[vcodec^=avc1][ext=mp4]/bv[ext=mp4]/b[ext=mp4]/best",
        "format_sort": ["res", "fps", "vcodec:h264"],
        "noplaylist": True,
        "playlistend": 1,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "socket_timeout": 25,
        "retries": 3,
        "fragment_retries": 3,
        "progress_hooks": [progress],
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(job["url"], download=True)
    _check_cancel(job)
    if isinstance(info, dict):
        _update(job, title=str(info.get("title") or "视频")[:120])


def _bbdown_download(job: dict) -> None:
    executable = APP_ROOT / "tools" / "BBDown" / "BBDown.exe"
    if not executable.is_file():
        raise RuntimeError("B 站下载组件缺失，请重新安装 DrumScribe")
    parsed = urlparse(job["url"])
    page = (parse_qs(parsed.query).get("p") or ["1"])[0]
    if not re.fullmatch(r"\d{1,3}", page) or int(page) < 1:
        page = "1"
    command = [str(executable), job["url"], "--work-dir", str(job["folder"]),
               "--file-pattern", "video", "--multi-file-pattern", "video",
               "--select-page", page, "--encoding-priority", "avc,hevc,av1",
               "--skip-subtitle", "--skip-cover", "--skip-ai", "--hide-streams",
               "--video-only", "--skip-mux"]
    process = subprocess.Popen(command, cwd=job["folder"], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                               errors="replace", creationflags=NO_WINDOW)
    _update(job, process=process, state="downloading", detail="B 站专用流程正在下载")
    tail: list[str] = []
    try:
        assert process.stdout is not None
        for line in process.stdout:
            _check_cancel(job)
            clean = line.strip()
            if clean:
                tail.append(clean)
                tail = tail[-8:]
                title = re.search(r"视频标题:\s*(.+)", clean)
                if title:
                    _update(job, title=title.group(1)[:120])
        return_code = process.wait()
        _check_cancel(job)
        if return_code != 0:
            raise RuntimeError("B 站下载失败：" + (tail[-1] if tail else f"退出码 {return_code}"))
    finally:
        if process.poll() is None:
            process.terminate()
        _update(job, process=None)


def _completed_file(folder: pathlib.Path) -> pathlib.Path:
    candidates = [path for path in folder.rglob("*")
                  if path.is_file() and path.suffix.lower() in _VIDEO_EXTENSIONS]
    if not candidates:
        raise RuntimeError("下载已结束，但没有得到可读取的视频文件")
    # Merged output takes precedence over yt-dlp's intermediate video track.
    candidates.sort(key=lambda path: (bool(re.fullmatch(r"video\.[^.]+", path.name)),
                                      path.stat().st_size), reverse=True)
    return candidates[0]


def _run(job: dict) -> None:
    global _ACTIVE
    try:
        _update(job, state="starting", detail="正在解析视频链接")
        if job["provider"] == "bilibili":
            _bbdown_download(job)
        else:
            _yt_dlp_download(job)
        _check_cancel(job)
        video = _completed_file(job["folder"])
        _update(job, state="done", percent=100, detail="下载完成，正在打开视频",
                file=video, filename=video.name)
    except Exception as error:
        if job["cancel"].is_set():
            _update(job, state="cancelled", detail="下载已取消")
        else:
            _update(job, state="error", detail=str(error)[-350:])
    finally:
        with _LOCK:
            if _ACTIVE == job["id"]:
                _ACTIVE = None


def start(text: str) -> tuple[int, dict]:
    global _ACTIVE
    url, provider = parse_video_link(text)
    with _LOCK:
        if _ACTIVE:
            return 409, {"ok": False, "reason": "已有视频正在下载"}
        job_id = secrets.token_hex(8)
        folder = DOWNLOADS / job_id
        folder.mkdir(parents=True, exist_ok=False)
        job = {"id": job_id, "url": url, "provider": provider, "folder": folder,
               "cancel": threading.Event(), "process": None,
               "state": "starting", "percent": 0, "detail": "正在解析视频链接"}
        _JOBS[job_id] = job
        _ACTIVE = job_id
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return 200, status(job_id)[1]


def status(job_id: str) -> tuple[int, dict]:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return 404, {"ok": False, "reason": "下载任务不存在"}
        result = {key: job.get(key) for key in
                  ("id", "provider", "state", "percent", "detail", "title", "filename")}
        result["ok"] = True
        if job["state"] == "done":
            result["fileUrl"] = f"/api/video-download/file?job={job_id}"
        return 200, result


def cancel(job_id: str) -> tuple[int, dict]:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return 404, {"ok": False, "reason": "下载任务不存在"}
        job["cancel"].set()
        process = job.get("process")
    if process and process.poll() is None:
        process.terminate()
    return status(job_id)


def shutdown() -> None:
    with _LOCK:
        ids = list(_JOBS)
    for job_id in ids:
        cancel(job_id)


def stream_file(handler, job_id: str) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        path = job.get("file") if job and job.get("state") == "done" else None
    if not path or not path.is_file():
        handler._send(404, {"ok": False, "reason": "视频文件不存在"})
        return
    size = path.stat().st_size
    range_header = handler.headers.get("Range", "")
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header) if range_header else None
    if range_header and not match:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.end_headers()
        return
    start = int(match.group(1)) if match and match.group(1) else 0
    end = int(match.group(2)) if match and match.group(2) else size - 1
    if match and not match.group(1) and match.group(2):
        start, end = max(0, size - int(match.group(2))), size - 1
    end = min(size - 1, end)
    if start >= size or end < start:
        handler.send_response(416)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.end_headers()
        return
    partial = bool(range_header)
    handler.send_response(206 if partial else 200)
    handler.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "video/mp4")
    handler.send_header("Content-Length", str(end - start + 1))
    handler.send_header("Accept-Ranges", "bytes")
    if partial:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    origin = handler._request_origin() if hasattr(handler, "_request_origin") else "*"
    if origin:
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
        handler.send_header("Vary", "Origin")
    handler.end_headers()
    try:
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass


atexit.register(shutdown)
