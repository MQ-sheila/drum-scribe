"""Standalone updater executable.  It must run outside the folder it replaces."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import uuid


NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def wait_for_parent(pid: int, timeout_ms: int = 120000) -> None:
    if os.name != "nt":
        raise RuntimeError("更新程序仅支持 Windows")
    synchronize = 0x00100000
    handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        raise RuntimeError("无法确认旧程序已退出")
    try:
        if ctypes.windll.kernel32.WaitForSingleObject(handle, timeout_ms) != 0:
            raise RuntimeError("旧程序未能及时退出")
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def write_result(work: pathlib.Path, ok: bool, message: str) -> None:
    work.mkdir(parents=True, exist_ok=True)
    (work / "last-result.json").write_text(
        json.dumps({"ok": ok, "message": message}, ensure_ascii=False), encoding="utf-8")


def launch(executable: pathlib.Path, marker: pathlib.Path | None = None) -> subprocess.Popen:
    args = [str(executable)]
    if marker:
        args.append(f"--update-health-marker={marker}")
    return subprocess.Popen(args, cwd=executable.parent, creationflags=NO_WINDOW)


def apply_update(install: pathlib.Path, staged: pathlib.Path, work: pathlib.Path,
                 health_timeout: float = 45) -> None:
    install = install.resolve()
    staged = staged.resolve()
    work = work.resolve()
    if (install.name != "DrumScribe" or staged.name != "DrumScribe" or
            staged.parent != work / "pending" / "staging" or
            install == staged or not (staged / "DrumScribe.exe").is_file()):
        raise ValueError("更新路径无效")
    backup = install.parent / ".DrumScribe-rollback"
    next_dir = install.parent / ".DrumScribe-next"
    if next_dir.exists():
        shutil.rmtree(next_dir)
    # Finish the potentially cross-volume copy before touching the old app.
    shutil.copytree(staged, next_dir)
    if not (next_dir / "DrumScribe.exe").is_file():
        raise RuntimeError("复制更新包失败")
    if backup.exists():
        shutil.rmtree(backup)
    # Both names share the same parent, so the old program remains available
    # until the complete staged folder is placed in the installation path.
    for attempt in range(20):
        try:
            install.rename(backup)
            break
        except OSError:
            if attempt == 19:
                raise
            time.sleep(1)
    try:
        next_dir.rename(install)
        marker = work / f"health-{uuid.uuid4().hex}.ok"
        process = launch(install / "DrumScribe.exe", marker)
        deadline = time.monotonic() + health_timeout
        while time.monotonic() < deadline:
            if marker.exists():
                marker.unlink()
                shutil.rmtree(backup, ignore_errors=True)
                try:
                    write_result(work, True, "已安装新版本")
                except OSError:
                    pass
                return
            if process.poll() is not None:
                break
            time.sleep(0.5)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        raise RuntimeError("新版本未能正常启动")
    except Exception:
        if install.exists():
            failed = work / "failed-install"
            if failed.exists():
                shutil.rmtree(failed)
            shutil.move(str(install), str(failed))
        backup.rename(install)
        if next_dir.exists():
            shutil.rmtree(next_dir, ignore_errors=True)
        write_result(work, False, "新版本启动失败，已恢复旧版本")
        launch(install / "DrumScribe.exe")
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--install", type=pathlib.Path, required=True)
    parser.add_argument("--staged", type=pathlib.Path, required=True)
    parser.add_argument("--work", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        wait_for_parent(args.pid)
        apply_update(args.install, args.staged, args.work)
    except Exception as error:
        write_result(args.work, False, f"安装更新失败：{error}")
        raise


if __name__ == "__main__":
    main()
