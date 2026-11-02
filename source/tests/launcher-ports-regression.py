"""Exercise packaged startup without opening the desktop window."""

from __future__ import annotations

import http.client
import pathlib
import re
import sys
from unittest.mock import patch
from urllib.parse import urlsplit


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import packaged_launcher  # noqa: E402


window_urls = []


def create_window(_title: str, url: str, **_options: object) -> None:
    window_urls.append(url)


def start(**_options: object) -> None:
    page = urlsplit(window_urls[-1])
    assert page.hostname == "127.0.0.1"
    static = http.client.HTTPConnection(page.hostname, page.port, timeout=5)
    static.request("GET", "/runtime-config.js")
    response = static.getresponse()
    script = response.read().decode("ascii")
    assert response.status == 200
    static.close()

    match = re.fullmatch(
        r"window\.DRUMSCRIBE_API_BASE = 'http://127\.0\.0\.1:(\d+)';\n",
        script,
    )
    assert match, script
    backend_port = int(match.group(1))
    assert backend_port != page.port

    backend = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=5)
    backend.request("GET", "/api/tools", headers={"Origin": f"http://127.0.0.1:{page.port}"})
    response = backend.getresponse()
    response.read()
    assert response.status == 200
    assert response.getheader("Access-Control-Allow-Origin") == f"http://127.0.0.1:{page.port}"
    backend.close()

    backend = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=5)
    backend.request("OPTIONS", "/api/tools", headers={"Origin": "http://untrusted.invalid"})
    response = backend.getresponse()
    response.read()
    assert response.status == 403
    backend.close()


with patch.object(packaged_launcher.webview, "create_window", side_effect=create_window), \
     patch.object(packaged_launcher.webview, "start", side_effect=start), \
     patch.object(packaged_launcher.omr_service, "terminate_active_processes"):
    packaged_launcher.main()

print("Launcher dynamic-port regression passed")
