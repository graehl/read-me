"""Take store: every recording of a line is kept; one take per line is marked accepted.

Layout under the data root (never committed):

    takes/<request>/<speaker>/<line>/<take>.flac   16 kHz mono FLAC
    takes/<request>/<speaker>/<line>/<take>.json   sidecar: request revision, line
                                                   text, capture settings, client checks
    takes/<request>/<speaker>/accepted.json        line id -> accepted take
    takes/<request>/<speaker>/events.jsonl         append-only take/accept history
    owners/<owner key>.jsonl                       takes uploaded by one browser, in order

A take whose sidecar is missing was interrupted mid-write and is ignored.
Ids arrive path-safe: the HTTP layer validates them against `SAFE_ID`.

An owner key is the sha256 of the random token a browser keeps in local storage and sends with each
upload; it lets that browser list and download its own takes. The token itself is never stored.
"""

from __future__ import annotations

import hashlib
import io
import json
import secrets
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path

from reading_requests import ReadingLine, ReadingRequest

MAX_TAKE_SECONDS = 90.0
STORED_SAMPLE_RATE = 16000


class TakeRejected(ValueError):
    """An upload that is not a storable take."""


@dataclass(frozen=True)
class StoredTake:
    take_id: str
    duration_s: float
    source_sample_rate: int


@dataclass(frozen=True)
class OwnedTake:
    """One take as listed to the browser that uploaded it."""

    request_id: str
    speaker: str
    line_id: str
    take_id: str
    number: int
    """1-based order of this take among the owner's takes of the same line."""
    line_text: str
    duration_s: float
    received_at: str
    accepted: bool

    @property
    def file_name(self) -> str:
        return f"{self.request_id}.{self.line_id}.{self.number:02d}.flac"


def owner_key(owner_token: str) -> str:
    """Storage key for a browser's owner token."""
    return hashlib.sha256(owner_token.encode()).hexdigest()


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_take_id() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(3)


def read_pcm_wav(wav_bytes: bytes) -> tuple[int, float]:
    """Check an upload is mono 16-bit PCM WAV; return (sample rate, seconds)."""
    try:
        with wave.open(io.BytesIO(wav_bytes)) as wav:
            channels, width, rate, frames = (
                wav.getnchannels(),
                wav.getsampwidth(),
                wav.getframerate(),
                wav.getnframes(),
            )
    except (wave.Error, EOFError) as exc:
        raise TakeRejected(f"Take upload is not a PCM WAV file: {exc}") from exc
    if channels != 1 or width != 2:
        raise TakeRejected(f"Take upload must be mono 16-bit PCM, got {channels} ch x {8 * width} bit")
    if not 8000 <= rate <= 192000 or frames == 0:
        raise TakeRejected(f"Take upload has an unusable sample rate {rate} or no samples")
    seconds = frames / rate
    if seconds > MAX_TAKE_SECONDS:
        raise TakeRejected(f"Take upload is {seconds:.0f} s, over the {MAX_TAKE_SECONDS:.0f} s limit")
    return rate, seconds


def encode_flac_16k(wav_bytes: bytes, out_path: Path) -> None:
    """Resample to 16 kHz mono FLAC, the program's storage form for PCM sources."""
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "wav",
            "-i",
            "pipe:0",
            "-af",
            "aresample=resampler=soxr",
            "-ar",
            str(STORED_SAMPLE_RATE),
            "-ac",
            "1",
            "-sample_fmt",
            "s16",
            "-f",
            "flac",
            str(out_path),
        ],
        input=wav_bytes,
        check=True,
        capture_output=True,
        timeout=60,
    )


def write_json_atomic(path: Path, doc: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


class TakeStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._accept_lock = threading.Lock()

    def speaker_dir(self, request_id: str, speaker: str) -> Path:
        return self.root / "takes" / request_id / speaker

    def _append_event(self, speaker_dir: Path, event: dict) -> None:
        with (speaker_dir / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    def save_take(
        self,
        request: ReadingRequest,
        line: ReadingLine,
        speaker: str,
        wav_bytes: bytes,
        client_report: dict,
        user_agent: str,
        owner: str | None = None,
    ) -> StoredTake:
        """Store one take; `owner` is the uploading browser's owner key, when it sent a token."""
        rate, seconds = read_pcm_wav(wav_bytes)
        speaker_dir = self.speaker_dir(request.id, speaker)
        line_dir = speaker_dir / line.id
        line_dir.mkdir(parents=True, exist_ok=True)
        take_id = new_take_id()
        flac_tmp = line_dir / f"{take_id}.flac.tmp"
        try:
            encode_flac_16k(wav_bytes, flac_tmp)
            flac_tmp.replace(line_dir / f"{take_id}.flac")
        except subprocess.CalledProcessError as exc:
            raise TakeRejected(f"Take FLAC encoding failed: {exc.stderr.decode(errors='replace')[:300]}") from exc
        finally:
            flac_tmp.unlink(missing_ok=True)
        sidecar = {
            "take_id": take_id,
            "received_at": utc_now(),
            "request_id": request.id,
            "request_revision": request.revision,
            "language": request.language,
            "line_id": line.id,
            "line_text": line.text,
            "speaker": speaker,
            "source_sample_rate": rate,
            "stored_sample_rate": STORED_SAMPLE_RATE,
            "duration_s": round(seconds, 3),
            "user_agent": user_agent,
            "owner_key": owner,
            "client": client_report,
        }
        write_json_atomic(line_dir / f"{take_id}.json", sidecar)
        self._append_event(
            speaker_dir, {"event": "take", "at": sidecar["received_at"], "line_id": line.id, "take_id": take_id}
        )
        if owner:
            owners_dir = self.root / "owners"
            owners_dir.mkdir(exist_ok=True)
            entry = {"request_id": request.id, "speaker": speaker, "line_id": line.id, "take_id": take_id}
            with (owners_dir / f"{owner}.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        return StoredTake(take_id=take_id, duration_s=seconds, source_sample_rate=rate)

    def take_path(self, take: OwnedTake) -> Path:
        return self.speaker_dir(take.request_id, take.speaker) / take.line_id / f"{take.take_id}.flac"

    def owned_takes(self, owner: str) -> list[OwnedTake]:
        """The takes one browser uploaded, oldest first; a take whose files are gone is skipped."""
        index = self.root / "owners" / f"{owner}.jsonl"
        if not index.is_file():
            return []
        accepted_by_speaker: dict[tuple[str, str], dict] = {}
        numbers: dict[tuple[str, str, str], int] = {}
        takes = []
        for raw in index.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                # An append interrupted mid-line; like a take without a sidecar, it is skipped.
                print(f"[store] Skipping unreadable owner index line in {index.name}", file=sys.stderr)
                continue
            request_id, speaker, line_id, take_id = (entry[k] for k in ("request_id", "speaker", "line_id", "take_id"))
            speaker_dir = self.speaker_dir(request_id, speaker)
            sidecar_path = speaker_dir / line_id / f"{take_id}.json"
            if not (sidecar_path.is_file() and sidecar_path.with_suffix(".flac").is_file()):
                continue
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            if (request_id, speaker) not in accepted_by_speaker:
                accepted_path = speaker_dir / "accepted.json"
                accepted_by_speaker[request_id, speaker] = (
                    json.loads(accepted_path.read_text()) if accepted_path.exists() else {}
                )
            line_key = (request_id, speaker, line_id)
            numbers[line_key] = numbers.get(line_key, 0) + 1
            takes.append(
                OwnedTake(
                    request_id=request_id,
                    speaker=speaker,
                    line_id=line_id,
                    take_id=take_id,
                    number=numbers[line_key],
                    line_text=sidecar["line_text"],
                    duration_s=sidecar["duration_s"],
                    received_at=sidecar["received_at"],
                    accepted=accepted_by_speaker[request_id, speaker].get(line_id, {}).get("take_id") == take_id,
                )
            )
        return takes

    def accept_take(self, request_id: str, speaker: str, line_id: str, take_id: str, override: bool) -> None:
        """Mark a stored take as the one to use for its line; earlier takes stay on disk."""
        speaker_dir = self.speaker_dir(request_id, speaker)
        if not (speaker_dir / line_id / f"{take_id}.json").is_file():
            raise TakeRejected(f"Take {take_id} for line {line_id} is not stored")
        with self._accept_lock:
            accepted_path = speaker_dir / "accepted.json"
            accepted = json.loads(accepted_path.read_text()) if accepted_path.exists() else {}
            entry = {"take_id": take_id, "accepted_at": utc_now(), "override": override}
            accepted[line_id] = entry
            write_json_atomic(accepted_path, accepted)
            self._append_event(
                speaker_dir,
                {
                    "event": "accept",
                    "at": entry["accepted_at"],
                    "line_id": line_id,
                    "take_id": take_id,
                    "override": override,
                },
            )

    def progress(self, request_id: str, speaker: str) -> dict:
        speaker_dir = self.speaker_dir(request_id, speaker)
        accepted_path = speaker_dir / "accepted.json"
        accepted = json.loads(accepted_path.read_text()) if accepted_path.exists() else {}
        take_counts = {}
        if speaker_dir.is_dir():
            for line_dir in speaker_dir.iterdir():
                if line_dir.is_dir():
                    take_counts[line_dir.name] = sum(1 for _ in line_dir.glob("*.json"))
        return {
            "accepted": {line_id: entry["take_id"] for line_id, entry in accepted.items()},
            "take_counts": take_counts,
        }
