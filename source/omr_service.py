"""Local OMR bridge entry point with a localhost-only CORS policy.

The implementation lives in :mod:`omr_service_engine` so the launch command
and existing integrations can keep using ``python omr_service.py``.  Browser
requests are accepted only from the DrumScope page on localhost:8765; command
line requests without an Origin header continue to work for diagnostics.
"""

from __future__ import annotations

import json

import omr_service_engine as _engine
from omr_service_engine import *  # noqa: F401,F403 - preserve the old module API


ALLOWED_ORIGINS = frozenset({
    "http://127.0.0.1:8765",
    "http://localhost:8765",
})


class RestrictedHandler(_engine.Handler):
    """Add a narrow CORS response policy while retaining the engine routes."""

    def _request_origin(self) -> str | None:
        origin = self.headers.get("Origin", "").strip()
        if not origin:
            return None
        return origin if origin in ALLOWED_ORIGINS else ""

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self._request_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self._request_origin()
        if self.headers.get("Origin") and not origin:
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.headers.get("Origin") and not self._request_origin():
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_POST()


# The engine's main() resolves Handler in its own module namespace. Replacing
# that binding keeps the original CLI and all route implementations intact.
_engine.Handler = RestrictedHandler


if __name__ == "__main__":
    _engine.main()
