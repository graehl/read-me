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
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import read_me_server
from owner_access import OwnerAccounts
from reading_requests import ReadingRequestCatalog, ReadingRequestError, parse_reading_request
from take_store import TakeStore, owner_key

REPO = Path(__file__).resolve().parents[1]


def tone_wav(seconds: float = 1.5, rate: int = 48000, bits: int = 16, fine: bool = True) -> bytes:
    """A 220 Hz tone; at 24 bits, `fine=False` leaves the low byte zero as a 16-bit converter would."""
    values = [int(8000 * math.sin(2 * math.pi * 220 * i / rate)) for i in range(int(seconds * rate))]
    if bits == 16:
        frames = b"".join(struct.pack("<h", v) for v in values)
    else:
        frames = b"".join(struct.pack("<i", (v << 8) + (i % 7 if fine else 0))[:3] for i, v in enumerate(values))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(bits // 8)
        w.setframerate(rate)
        w.writeframes(frames)
    return buf.getvalue()


@pytest.fixture
def server(tmp_path: Path):
    read_me_server.ReadMeHandler.catalog = ReadingRequestCatalog(REPO / "requests")
    read_me_server.ReadMeHandler.store = TakeStore(tmp_path)
    read_me_server.ReadMeHandler.owners = OwnerAccounts(tmp_path)
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


def fetch_bytes(url: str, headers: dict) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def test_a_browser_downloads_only_its_own_takes(server):
    base, data_root = server
    mine, other = {"X-Read-Me-Owner": "ab" * 24}, {"X-Read-Me-Owner": "cd" * 24}
    upload = {"Content-Type": "audio/wav"}
    api = f"{base}/api/requests/demo-en/speakers/tester/lines"
    call(f"{api}/0001/takes", tone_wav(), {**upload, **mine})
    kept = call(f"{api}/0001/takes", tone_wav(), {**upload, **mine})[1]["take_id"]
    call(f"{api}/0002/takes", tone_wav(), {**upload, **other})
    call(f"{api}/0003/takes", tone_wav(), upload)
    call(f"{api}/0001/accept", json.dumps({"take_id": kept, "override": False}).encode())

    status, listing = call(f"{base}/api/mine", headers=mine)
    takes = listing["takes"]
    assert status == 200
    assert [(t["file_name"], t["accepted"]) for t in takes] == [
        ("demo-en.0001.01.flac", False),
        ("demo-en.0001.02.flac", True),
    ]
    status, flac = fetch_bytes(base + takes[1]["url"], mine)
    assert status == 200 and flac.startswith(b"fLaC")
    assert fetch_bytes(base + takes[1]["url"], other)[0] == 404

    status, archive = fetch_bytes(f"{base}/api/mine/takes.zip", mine)
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        names = sorted(z.namelist())
        manifest = z.read("takes.tsv").decode().splitlines()
    assert names == ["takes.tsv", "tester/demo-en.0001.01.flac", "tester/demo-en.0001.02.flac"]
    assert manifest[2].split("\t")[5] == "yes"
    with zipfile.ZipFile(io.BytesIO(fetch_bytes(f"{base}/api/mine/kept.zip", mine)[1])) as z:
        assert sorted(z.namelist()) == ["takes.tsv", "tester/demo-en.0001.02.flac"]

    with (data_root / "owners" / f"{owner_key('ab' * 24)}.jsonl").open("a", encoding="utf-8") as f:
        f.write('{"request_id": "demo-en", "spea')
    assert len(call(f"{base}/api/mine", headers=mine)[1]["takes"]) == 2

    assert call(f"{base}/api/mine")[0] == 401
    assert call(f"{base}/api/mine", headers={"X-Read-Me-Owner": "not-hex"})[0] == 400


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
        {"language": "en", "lines": ["a"], "guide_notes": "one string"},
        {"language": "en", "lines": ["a"], "guide_notes": [""]},
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


def test_requests_come_from_every_directory_and_one_id_may_not_repeat(tmp_path: Path):
    public, private = tmp_path / "requests", tmp_path / "data" / "requests"
    public.mkdir()
    private.mkdir(parents=True)
    (public / "demo.json").write_text(json.dumps({"language": "en", "lines": ["a"]}))
    (private / "assigned.json").write_text(
        json.dumps({"language": "si", "guide_notes": ["Rude lines."], "lines": ["b"]})
    )
    catalog = ReadingRequestCatalog(public, private, tmp_path / "missing")
    assert catalog.ids() == ["assigned", "demo"]
    assert catalog.load("assigned").guide_notes == ("Rude lines.",)
    (private / "demo.json").write_text(json.dumps({"language": "en", "lines": ["c"]}))
    with pytest.raises(ReadingRequestError, match="defined twice"):
        catalog.load("demo")


def test_the_recorder_page_takes_the_speaker_in_its_path(server):
    base, _ = server
    for path in ("/r/demo-en", "/r/demo-en/", "/r/demo-en/disney"):
        with urllib.request.urlopen(base + path) as resp:
            assert 'id="guide"' in resp.read().decode()
    assert fetch_bytes(f"{base}/r/demo-en/a/b", {})[0] == 404


def login(base: str, user: str, password: str) -> tuple[int, str]:
    """Status and the session cookie pair ("name=value") of an owner login."""
    body = json.dumps({"user": user, "password": password}).encode()
    status, _ = call(f"{base}/api/owner/login", body)
    if status != 200:
        return status, ""
    req = urllib.request.Request(f"{base}/api/owner/login", data=body, method="POST")
    with urllib.request.urlopen(req) as resp:
        return status, resp.headers["Set-Cookie"].split(";")[0]


def test_the_first_owner_login_sets_the_password_and_unlocks_every_take(server):
    base, data_root = server
    api = f"{base}/api/requests/demo-en/speakers"
    upload = {"Content-Type": "audio/wav"}
    kept = call(f"{api}/a/lines/0001/takes", tone_wav(), upload)[1]["take_id"]
    call(f"{api}/a/lines/0001/accept", json.dumps({"take_id": kept, "override": False}).encode())
    call(f"{api}/a/lines/0001/takes", tone_wav(), upload)
    call(f"{api}/b/lines/0002/takes", tone_wav(), upload)

    assert call(f"{base}/api/owner/takes")[0] == 401
    status, cookie = login(base, "owner", "first-password")
    assert status == 200 and (data_root / "owner-accounts.json").is_file()
    assert "first-password" not in (data_root / "owner-accounts.json").read_text()
    assert login(base, "owner", "other")[0] == 401
    assert login(base, "someone", "first-password")[0] == 401

    status, listing = call(f"{base}/api/owner/takes", headers={"Cookie": cookie})
    assert status == 200 and len(listing["takes"]) == 3
    assert fetch_bytes(base + listing["takes"][0]["url"], {"Cookie": cookie})[1].startswith(b"fLaC")

    def zip_names(path: str) -> list[str]:
        with zipfile.ZipFile(io.BytesIO(fetch_bytes(base + path, {"Cookie": cookie})[1])) as z:
            return sorted(n for n in z.namelist() if n != "takes.tsv")

    assert zip_names("/api/owner/kept.zip") == ["a/demo-en.0001.01.flac"]
    assert len(zip_names("/api/owner/takes.zip")) == 3
    assert zip_names("/api/owner/demo-en/b/takes.zip") == ["b/demo-en.0002.01.flac"]
    assert fetch_bytes(f"{base}/api/owner/takes.zip", {"Cookie": cookie.replace("owner.", "evil.")})[0] == 401


def flac_format(path: Path) -> str:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,bits_per_raw_sample", "-of", "csv=p=0", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def test_a_take_is_also_kept_at_its_capture_rate_and_precision(server):
    base, data_root = server
    api = f"{base}/api/requests/demo-en/speakers/hifi/lines"
    upload = {"Content-Type": "audio/wav"}
    fine = call(f"{api}/0001/takes", tone_wav(bits=24, fine=True), upload)[1]["take_id"]
    coarse = call(f"{api}/0002/takes", tone_wav(bits=24, fine=False), upload)[1]["take_id"]
    takes = data_root / "takes" / "demo-en" / "hifi"

    assert flac_format(takes / "0001" / f"{fine}.flac") == "16000,16"
    assert flac_format(takes / "0001" / f"{fine}.orig.flac") == "48000,24"
    assert flac_format(takes / "0002" / f"{coarse}.orig.flac") == "48000,16"
    sidecar = json.loads((takes / "0002" / f"{coarse}.json").read_text())
    assert (sidecar["source_bits"], sidecar["source_effective_bits"]) == (24, 16)

    _, cookie = login(base, "owner", "pw")
    with zipfile.ZipFile(io.BytesIO(fetch_bytes(f"{base}/api/owner/hifi/takes.orig.zip", {"Cookie": cookie})[1])) as z:
        assert z.namelist() == ["takes.tsv"]
    archive = fetch_bytes(f"{base}/api/owner/demo-en/hifi/takes.orig.zip", {"Cookie": cookie})[1]
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        assert sorted(z.namelist()) == ["hifi/demo-en.0001.01.orig.flac", "hifi/demo-en.0002.01.orig.flac", "takes.tsv"]
        assert z.read("takes.tsv").decode().splitlines()[1].split("\t")[7] == "48000"
    single = f"{base}/api/owner/takes/demo-en/hifi/0001/{fine}.orig.flac"
    assert fetch_bytes(single, {"Cookie": cookie})[1].startswith(b"fLaC")
