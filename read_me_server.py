#!/usr/bin/env python3
"""read-me server: serves reading requests to a phone browser and stores every take.

    ./read_me_server.py --port 3470 --data /gr6/read-me

Routes:
    GET  /healthz
    GET  /                              list of reading requests
    GET  /r/<request>?speaker=<name>    the recorder page
    GET  /static/<file>
    GET  /api/requests/<request>
    GET  /api/requests/<request>/speakers/<speaker>/progress
    POST /api/requests/<request>/speakers/<speaker>/lines/<line>/takes    body: mono 16-bit WAV,
         header X-Read-Me-Take: percent-encoded JSON client report (capture settings, checks)
    POST /api/requests/<request>/speakers/<speaker>/lines/<line>/accept   body: {"take_id", "override"}
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import sys
import traceback
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from reading_requests import SAFE_ID_PATTERN, ReadingRequestCatalog, ReadingRequestError, is_safe_id
from take_store import TakeRejected, TakeStore

REPO_DIR = Path(__file__).resolve().parent
STATIC_DIR = REPO_DIR / "static"
MAX_UPLOAD_BYTES = 40 * 1024 * 1024
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    "Permissions-Policy": "microphone=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
}

ID = f"({SAFE_ID_PATTERN})"
SPEAKER_API = rf"^/api/requests/{ID}/speakers/{ID}"
ROUTE_REQUEST_PAGE = re.compile(rf"^/r/{ID}/?$")
ROUTE_STATIC = re.compile(r"^/static/([A-Za-z0-9._-]+)$")
ROUTE_REQUEST = re.compile(rf"^/api/requests/{ID}$")
ROUTE_PROGRESS = re.compile(SPEAKER_API + r"/progress$")
ROUTE_TAKES = re.compile(SPEAKER_API + rf"/lines/{ID}/takes$")
ROUTE_ACCEPT = re.compile(SPEAKER_API + rf"/lines/{ID}/accept$")


class BadRequest(ValueError):
    """A request whose headers or body are malformed."""


class ReadMeHandler(BaseHTTPRequestHandler):
    server_version = "read-me/0.1"
    catalog: ReadingRequestCatalog
    store: TakeStore

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write(f"[http] {self.address_string()} {format % args}\n")

    def send_body(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, doc: object) -> None:
        self.send_body(status, json.dumps(doc, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def do_GET(self) -> None:
        self.dispatch(self.route_get)

    do_HEAD = do_GET

    def do_POST(self) -> None:
        if not self.same_origin():
            return self.send_error_json(403, "Cross-origin post refused")
        self.dispatch(self.route_post)

    def dispatch(self, route: Callable[[str], None]) -> None:
        """Map every failure of one request to a status: client input 400, server state 500."""
        try:
            route(urlsplit(self.path).path)
        except (TakeRejected, BadRequest) as exc:
            self.send_error_json(400, str(exc))
        except ReadingRequestError as exc:
            self.log_message("%s", exc)
            self.send_error_json(500, str(exc))
        except Exception:  # noqa: BLE001 - the request boundary answers 500 rather than dropping the connection
            self.log_message("Unhandled error on %s %s:\n%s", self.command, self.path, traceback.format_exc())
            self.send_error_json(500, "Internal server error")

    def route_get(self, path: str) -> None:
        if path == "/healthz":
            return self.send_body(200, b"ok\n", "text/plain; charset=utf-8")
        if path == "/":
            return self.send_request_index()
        if ROUTE_REQUEST_PAGE.match(path):
            return self.send_static("index.html")
        if m := ROUTE_STATIC.match(path):
            return self.send_static(m.group(1))
        if m := ROUTE_REQUEST.match(path):
            request = self.catalog.load(m.group(1))
            if request is None:
                return self.send_error_json(404, f"No reading request {m.group(1)}")
            return self.send_json(200, request.to_json())
        if m := ROUTE_PROGRESS.match(path):
            return self.send_json(200, self.store.progress(m.group(1), m.group(2)))
        self.send_error_json(404, "Not found")

    def route_post(self, path: str) -> None:
        if m := ROUTE_TAKES.match(path):
            return self.post_take(*m.groups())
        if m := ROUTE_ACCEPT.match(path):
            return self.post_accept(*m.groups())
        self.send_error_json(404, "Not found")

    def send_request_index(self) -> None:
        items = []
        for request_id in self.catalog.ids():
            try:
                request = self.catalog.load(request_id)
            except ReadingRequestError as exc:
                self.log_message("%s", exc)
                continue
            if request is not None:
                items.append(
                    f'<li><a href="r/{html.escape(request.id)}">{html.escape(request.title)}</a> '
                    f"({len(request.lines)} lines, {html.escape(request.language)})</li>"
                )
        body = (
            '<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>read-me</title><link rel="icon" href="data:,"><link rel="stylesheet" href="static/read-me.css">'
            '<main class="index"><h1>Reading requests</h1><ul>' + "".join(items) + "</ul></main></html>"
        )
        self.send_body(200, body.encode(), "text/html; charset=utf-8")

    def send_static(self, name: str) -> None:
        path = STATIC_DIR / name
        content_type = STATIC_TYPES.get(path.suffix)
        if content_type is None or not path.is_file():
            return self.send_error_json(404, "Not found")
        self.send_body(200, path.read_bytes(), content_type)

    def same_origin(self) -> bool:
        """Reject cross-site posts; a missing Origin (non-browser client) is allowed."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
        return urlsplit(origin).netloc == host

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as exc:
            raise BadRequest("Content-Length is not a number") from exc
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            raise BadRequest(f"Upload size {length} outside 1..{MAX_UPLOAD_BYTES} bytes")
        return self.rfile.read(length)

    def post_accept(self, request_id: str, speaker: str, line_id: str) -> None:
        try:
            doc = json.loads(self.read_body())
        except ValueError as exc:
            raise BadRequest(f"Accept body is not JSON: {exc}") from exc
        take_id = doc.get("take_id") if isinstance(doc, dict) else None
        override = doc.get("override", False) if isinstance(doc, dict) else None
        if not (isinstance(take_id, str) and is_safe_id(take_id) and isinstance(override, bool)):
            raise BadRequest('Accept body must be {"take_id": <take id>, "override": <true|false>}')
        self.store.accept_take(request_id, speaker, line_id, take_id, override)
        self.send_json(200, self.store.progress(request_id, speaker))

    def post_take(self, request_id: str, speaker: str, line_id: str) -> None:
        request = self.catalog.load(request_id)
        line = request.line(line_id) if request else None
        if request is None or line is None:
            return self.send_error_json(404, f"No line {line_id} in reading request {request_id}")
        report_header = self.headers.get("X-Read-Me-Take") or "{}"
        try:
            client_report = json.loads(unquote(report_header))
        except json.JSONDecodeError:
            client_report = {"unparsed": report_header[:2000]}
        take = self.store.save_take(
            request, line, speaker, self.read_body(), client_report, self.headers.get("User-Agent", "")
        )
        self.send_json(
            201,
            {
                "take_id": take.take_id,
                "duration_s": round(take.duration_s, 3),
                "source_sample_rate": take.source_sample_rate,
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve reading requests and store recorded takes.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", "3470")), help="listen port (default: $PORT, else 3470)"
    )
    parser.add_argument("--data", type=Path, required=True, help="data root for takes; never committed")
    parser.add_argument(
        "--requests", type=Path, default=REPO_DIR / "requests", help="directory of <id>.json reading requests"
    )
    args = parser.parse_args()
    if shutil.which("ffmpeg") is None:
        sys.exit("read-me: ffmpeg is required to store takes as FLAC")
    args.data.mkdir(parents=True, exist_ok=True)
    ReadMeHandler.catalog = ReadingRequestCatalog(args.requests)
    ReadMeHandler.store = TakeStore(args.data)
    server = ThreadingHTTPServer((args.host, args.port), ReadMeHandler)
    print(
        f"[serve] read-me on http://{args.host}:{args.port} requests={args.requests} data={args.data}", file=sys.stderr
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
