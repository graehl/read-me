"""Integration: a take posted over HTTP is stored as 16 kHz FLAC with its sidecar, and accepting it
updates the speaker's progress while every take stays on disk."""

from __future__ import annotations

import io
import json
import math
import struct
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import read_me_server
from reading_requests import ReadingRequestCatalog, ReadingRequestError, parse_reading_request
from take_store import TakeStore

REPO = Path(__file__).resolve().parents[1]


def tone_wav(seconds: float = 1.5, rate: int = 48000) -> bytes:
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(int(seconds * rate))
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


@pytest.fixture
def server(tmp_path: Path):
    read_me_server.ReadMeHandler.catalog = ReadingRequestCatalog(REPO / "requests")
    read_me_server.ReadMeHandler.store = TakeStore(tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), read_me_server.ReadMeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", tmp_path
    httpd.shutdown()


def call(url: str, data: bytes | None = None, headers: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_takes_are_kept_and_the_accepted_one_is_recorded(server):
    base, data = server
    api = f"{base}/api/requests/demo-en/speakers/tester"
    status, request = call(f"{base}/api/requests/demo-en")
    assert status == 200 and request["language"] == "en" and len(request["lines"]) == 5

    report = {"checks": {"findings": [{"id": "ok", "level": "ok"}]}}
    header = {"Content-Type": "audio/wav", "X-Read-Me-Take": urllib.parse.quote(json.dumps(report))}
    first = call(f"{api}/lines/0001/takes", tone_wav(), header)
    second = call(f"{api}/lines/0001/takes", tone_wav(), header)
    assert first[0] == second[0] == 201

    status, progress = call(f"{api}/lines/0001/accept", json.dumps({"take_id": second[1]["take_id"]}).encode())
    assert status == 200
    assert progress["accepted"] == {"0001": second[1]["take_id"]}
    assert progress["take_counts"] == {"0001": 2}

    line_dir = data / "takes" / "demo-en" / "tester" / "0001"
    flac = line_dir / f"{first[1]['take_id']}.flac"
    rate = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", str(flac)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert rate == "16000,1"
    sidecar = json.loads((line_dir / f"{first[1]['take_id']}.json").read_text())
    assert sidecar["source_sample_rate"] == 48000
    assert sidecar["line_text"].startswith("The bus to the airport")
    assert sidecar["client"] == report
    assert len((data / "takes" / "demo-en" / "tester" / "events.jsonl").read_text().splitlines()) == 3


def test_rejects_unknown_takes_non_wav_and_cross_origin_posts(server):
    base, _ = server
    api = f"{base}/api/requests/demo-en/speakers/tester"
    assert call(f"{api}/lines/0001/accept", json.dumps({"take_id": "nope"}).encode())[0] == 400
    assert call(f"{api}/lines/0001/takes", b"not a wav", {"Content-Type": "audio/wav"})[0] == 400
    assert call(f"{api}/lines/9999/takes", tone_wav(), {"Content-Type": "audio/wav"})[0] == 404
    cross = {"Content-Type": "audio/wav", "Origin": "https://evil.example"}
    assert call(f"{api}/lines/0001/takes", tone_wav(), cross)[0] == 403


def test_malformed_posts_get_400_not_a_dropped_connection(server):
    base, _ = server
    api = f"{base}/api/requests/demo-en/speakers/tester/lines/0001"
    assert call(f"{api}/accept", b"[]")[0] == 400
    assert call(f"{api}/accept", json.dumps({"take_id": "x", "override": "false"}).encode())[0] == 400
    assert call(f"{api}/accept", b"\xff\xfe")[0] == 400
    assert call(f"{api}/takes", tone_wav(), {"Content-Length": "many"})[0] == 400


def test_a_malformed_request_file_does_not_break_the_index(tmp_path: Path):
    (tmp_path / "bad.json").write_text(json.dumps({"language": "en", "lines": [42]}))
    (tmp_path / "good.json").write_text(json.dumps({"language": "en", "lines": ["a"]}))
    read_me_server.ReadMeHandler.catalog = ReadingRequestCatalog(tmp_path)
    read_me_server.ReadMeHandler.store = TakeStore(tmp_path / "data")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), read_me_server.ReadMeHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        with urllib.request.urlopen(f"{base}/") as resp:
            assert 'href="r/good"' in resp.read().decode()
        assert call(f"{base}/api/requests/bad")[0] == 500
    finally:
        httpd.shutdown()


@pytest.mark.parametrize(
    "doc",
    [
        {"language": "en", "lines": [42]},
        {"language": "en", "lines": ["a"], "asr_check": "x"},
        {"language": "en", "lines": ["a"], "asr_check": {"min_accuracy": "high"}},
        {"language": "en", "lines": ["a"], "asr_check": {"min_accuracy": True}},
    ],
)
def test_malformed_request_fields_raise_reading_request_error(doc):
    with pytest.raises(ReadingRequestError):
        parse_reading_request("x", json.dumps(doc).encode())


def test_reading_request_requires_language_and_accepts_plain_string_lines():
    with pytest.raises(ReadingRequestError, match="'language' is required"):
        parse_reading_request("x", json.dumps({"lines": ["a"]}).encode())
    request = parse_reading_request("x", json.dumps({"language": "si", "lines": ["one  line", "two"]}).encode())
    assert [(line.id, line.text) for line in request.lines] == [("0001", "one line"), ("0002", "two")]
    assert request.asr_check.min_accuracy == 0.2
