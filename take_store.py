"""Take store: every recording of a line is kept; one take per line is marked accepted.

Layout under the data root (never committed):

    takes/<request>/<speaker>/<line>/<take>.flac   16 kHz mono FLAC
    takes/<request>/<speaker>/<line>/<take>.json   sidecar: request revision, line
                                                   text, capture settings, client checks
    takes/<request>/<speaker>/accepted.json        line id -> accepted take
    takes/<request>/<speaker>/events.jsonl         append-only take/accept history

A take whose sidecar is missing was interrupted mid-write and is ignored.
Ids arrive path-safe: the HTTP layer validates them against `SAFE_ID`.
"""

from __future__ import annotations

import io
import json
import secrets
import subprocess
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
    ) -> StoredTake:
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
            "client": client_report,
        }
        write_json_atomic(line_dir / f"{take_id}.json", sidecar)
        self._append_event(
            speaker_dir, {"event": "take", "at": sidecar["received_at"], "line_id": line.id, "take_id": take_id}
        )
        return StoredTake(take_id=take_id, duration_s=seconds, source_sample_rate=rate)

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
