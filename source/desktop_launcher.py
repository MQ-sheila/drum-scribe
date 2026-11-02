from __future__ import annotations

import os
import pathlib
import socket
import subprocess
import sys
import time
import webbrowser


ROOT = pathlib.Path(__file__).resolve().parent
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.25)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def start_if_needed(port: int, command: list[str]) -> None:
    if port_open(port):
        return
    subprocess.Popen(
        command,
        cwd=ROOT,
        creationflags=NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def browser_executable(preferred: str = "chrome") -> str | None:
    candidates = [
        pathlib.Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        pathlib.Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        pathlib.Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        pathlib.Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    if preferred == "edge":
        candidates = candidates[3:] + candidates[:3]
    return next((str(path) for path in candidates if path.is_file()), None)


def main() -> None:
    start_if_needed(8767, [sys.executable, str(ROOT / "omr_service.py"), "--port", "8767"])
    start_if_needed(8765, [sys.executable, "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", str(ROOT)])
    for _ in range(30):
        if port_open(8765) and port_open(8767):
            break
        time.sleep(0.1)
    url = "http://127.0.0.1:8765/?desktop=1"
    preferred = sys.argv[1].lower() if len(sys.argv) > 1 else "chrome"
    browser = browser_executable(preferred)
    if browser:
        subprocess.Popen([browser, f"--app={url}", "--start-maximized"])
    else:
        webbrowser.open(url)


if __name__ == "__main__":
    main()
