"""GitHub Releases updater for the packaged Windows application.

Downloads are staged outside the installation.  A separate executable performs
the actual directory swap after the desktop process exits.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import zipfile


USER_AGENT = "DrumScribe-Updater"
MAX_ARCHIVE_SIZE = 4 * 1024**3
MAX_UNPACKED_SIZE = 5 * 1024**3
MAX_FILES = 12000
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def version_tuple(value: str) -> tuple[int, ...]:
    match = re.fullmatch(r"v?(\d+(?:\.\d+){1,3})", value.strip())
    if not match:
        raise ValueError("版本号格式无效")
    return tuple(int(part) for part in match.group(1).split("."))


def read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def release_from_payload(payload: dict, current: str, asset_name: str) -> dict | None:
    version = str(payload.get("tag_name", ""))
    if version_tuple(version) <= version_tuple(current):
        return None
    asset = next((item for item in payload.get("assets", [])
                  if item.get("name") == asset_name), None)
    if not asset:
        raise ValueError(f"新版本缺少 {asset_name}")
    digest = str(asset.get("digest") or "")
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        raise ValueError("更新包缺少 SHA-256 校验值")
    url = str(asset.get("browser_download_url") or "")
    expected = f"https://github.com/{payload['owner']}/{payload['repo']}/releases/download/"
    if not url.startswith(expected):
        raise ValueError("更新包下载地址不属于指定仓库")
    size = int(asset.get("size") or 0)
    if size <= 0 or size > MAX_ARCHIVE_SIZE:
        raise ValueError("更新包大小无效")
    return {"version": version.lstrip("v"), "url": url,
            "sha256": digest.split(":", 1)[1].lower(), "size": size,
            "notes": str(payload.get("body") or "")[:3000]}


def extract_release(archive: pathlib.Path, destination: pathlib.Path) -> pathlib.Path:
    """Extract only a single DrumScribe/ tree; reject traversal and links."""
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > MAX_FILES or sum(info.file_size for info in infos) > MAX_UNPACKED_SIZE:
            raise ValueError("更新包内容过大")
        seen: set[str] = set()
        for info in infos:
            name = info.filename
            parts = pathlib.PurePosixPath(name).parts
            if (not parts or parts[0] != "DrumScribe" or
                    any(part in ("", ".", "..") for part in parts) or
                    name.startswith("/") or ":" in name or "\\" in name or
                    (info.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError("更新包包含非法路径")
            key = name.rstrip("/").casefold()
            if key in seen:
                raise ValueError("更新包包含重复文件")
            seen.add(key)
        destination.mkdir(parents=True, exist_ok=True)
        for info in infos:
            target = destination.joinpath(*pathlib.PurePosixPath(info.filename).parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
    app_dir = destination / "DrumScribe"
    if not (app_dir / "DrumScribe.exe").is_file() or not (app_dir / "VERSION.txt").is_file():
        raise ValueError("更新包缺少程序或版本号")
    return app_dir


class UpdateManager:
    def __init__(self, app_root: pathlib.Path, install_dir: pathlib.Path,
                 data_dir: pathlib.Path | None = None):
        self.app_root = app_root
        self.install_dir = install_dir
        self.data_dir = data_dir or pathlib.Path(os.environ["LOCALAPPDATA"]) / "DrumScribe"
        self.work_dir = self.data_dir / "updates"
        self.current_version = (app_root / "VERSION.txt").read_text(encoding="utf-8-sig").strip()
        self.config = read_json(app_root / "update_config.json")
        self.repository = str(self.config["repository"])
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise ValueError("更新仓库配置无效")
        self.asset_name = str(self.config["asset"])
        self._lock = threading.Lock()
        self._release: dict | None = None
        self._staged: pathlib.Path | None = None
        self._status = {"state": "idle", "currentVersion": self.current_version,
                        "progress": 0, "message": ""}
        result = self.work_dir / "last-result.json"
        if result.is_file():
            try:
                self._status["lastResult"] = read_json(result)
                result.unlink()
            except (OSError, ValueError, json.JSONDecodeError):
                pass

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def _set(self, **values: object) -> dict:
        with self._lock:
            self._status.update(values)
            return dict(self._status)

    def check(self) -> dict:
        if not getattr(sys, "frozen", False):
            return self._set(state="unavailable", message="源码运行时不检查更新")
        if self.status()["state"] in ("downloading", "ready", "installing"):
            return self.status()
        self._set(state="checking", message="正在检查更新…")
        try:
            owner, repo = self.repository.split("/", 1)
            url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
            request = urllib.request.Request(url, headers={
                "Accept": "application/vnd.github+json", "User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.load(response)
            payload["owner"], payload["repo"] = owner, repo
            release = release_from_payload(payload, self.current_version, self.asset_name)
            self._release = release
            if release:
                return self._set(state="available", message="发现新版本",
                                 version=release["version"], size=release["size"],
                                 notes=release["notes"], progress=0)
            return self._set(state="current", message="已是最新版本", progress=0)
        except urllib.error.HTTPError as error:
            message = "尚未发布可用版本" if error.code == 404 else f"检查更新失败（HTTP {error.code}）"
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            message = f"检查更新失败：{error}"
        return self._set(state="error", message=message)

    def start_download(self) -> dict:
        if not self._release or self.status()["state"] not in ("available", "error"):
            return self.status()
        self._set(state="downloading", message="正在下载更新…", progress=0)
        threading.Thread(target=self._download, daemon=True).start()
        return self.status()

    def _download(self) -> None:
        release = self._release
        assert release is not None
        pending = self.work_dir / "pending"
        try:
            self.work_dir.mkdir(parents=True, exist_ok=True)
            if pending.exists():
                shutil.rmtree(pending)
            pending.mkdir()
            archive = pending / "package.zip"
            request = urllib.request.Request(release["url"], headers={"User-Agent": USER_AGENT})
            digest = hashlib.sha256()
            received = 0
            with urllib.request.urlopen(request, timeout=30) as response, archive.open("wb") as output:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > MAX_ARCHIVE_SIZE or received > release["size"]:
                        raise ValueError("下载文件超出预期大小")
                    digest.update(block)
                    output.write(block)
                    self._set(progress=min(99, round(received * 100 / release["size"])))
            if received != release["size"] or digest.hexdigest() != release["sha256"]:
                raise ValueError("更新包校验失败")
            self._set(message="正在解压和检查更新包…", progress=99)
            staged = extract_release(archive, pending / "staging")
            if version_tuple((staged / "VERSION.txt").read_text(encoding="utf-8-sig")) != version_tuple(release["version"]):
                raise ValueError("更新包版本与发布信息不符")
            if not (staged / "DrumScribeUpdater.exe").is_file():
                raise ValueError("更新包缺少更新程序")
            archive.unlink()
            self._staged = staged
            self._set(state="ready", message="更新已准备好，重启后安装", progress=100)
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            self._set(state="error", message=f"下载更新失败：{error}", progress=0)
            if pending.exists():
                shutil.rmtree(pending, ignore_errors=True)

    def launch_install(self) -> dict:
        if self.status()["state"] != "ready" or not self._staged:
            return self.status()
        try:
            helper_source = self.install_dir / "DrumScribeUpdater.exe"
            helper = self.work_dir / "DrumScribeUpdater.exe"
            shutil.copy2(helper_source, helper)
            subprocess.Popen([
                str(helper), "--apply", "--pid", str(os.getpid()),
                "--install", str(self.install_dir), "--staged", str(self._staged),
                "--work", str(self.work_dir),
            ], cwd=self.work_dir, creationflags=NO_WINDOW,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._set(state="installing", message="正在退出并安装更新…")
        except OSError as error:
            return self._set(state="error", message=f"无法启动更新程序：{error}")
