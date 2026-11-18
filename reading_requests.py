"""Reading requests: the prerequested line lists a speaker is asked to read aloud.

A request file is JSON in the requests directory, named `<id>.json`:

    {
      "title": "Demo: five English lines",
      "language": "en",                   # required, BCP 47
      "instructions": "optional text shown above the lines",
      "asr_check": {"metric": "ERn", "min_accuracy": 0.2},   # optional
      "lines": ["First line.", {"id": "0002", "text": "Second line."}]
    }

`language` is required because a later recognizer check needs it to pick a
recognizer and scoring view. `asr_check` defaults to the values in
`AsrCheck`; a request built from text known to be hard for current
recognizers sets a lower `min_accuracy`.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

SAFE_ID_PATTERN = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
"""Request, speaker, line and take ids; static/index.html's speaker field repeats it for the browser."""
SAFE_ID = re.compile(rf"^{SAFE_ID_PATTERN}$")
LANGUAGE_TAG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")


class ReadingRequestError(ValueError):
    """A reading request file that cannot be served."""


def is_safe_id(value: str) -> bool:
    """Whether a request, speaker or line id is safe as a path component."""
    return bool(SAFE_ID.match(value))


@dataclass(frozen=True)
class AsrCheck:
    """Recognizer validation a request asks for; accuracy is 1 - error rate."""

    metric: str = "ERn"
    min_accuracy: float = 0.2


@dataclass(frozen=True)
class ReadingLine:
    id: str
    text: str


@dataclass(frozen=True)
class ReadingRequest:
    id: str
    title: str
    language: str
    instructions: str
    asr_check: AsrCheck
    lines: tuple[ReadingLine, ...]
    revision: str = field(compare=False)
    """sha256 prefix of the request file, so a take records the text it was read from."""

    def line(self, line_id: str) -> ReadingLine | None:
        return next((line for line in self.lines if line.id == line_id), None)

    def to_json(self) -> dict:
        return asdict(self)


def parse_reading_request(request_id: str, raw: bytes) -> ReadingRequest:
    """Validate and normalize one request file's bytes."""
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ReadingRequestError(f"Reading request {request_id}: invalid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise ReadingRequestError(f"Reading request {request_id}: top level must be an object")

    language = doc.get("language")
    if not isinstance(language, str) or not LANGUAGE_TAG.match(language):
        raise ReadingRequestError(
            f"Reading request {request_id}: 'language' is required (a BCP 47 tag such as 'en' or 'si')"
        )

    check_doc = doc.get("asr_check") or {}
    if not isinstance(check_doc, dict):
        raise ReadingRequestError(f"Reading request {request_id}: 'asr_check' must be an object")
    default = AsrCheck()
    min_accuracy = check_doc.get("min_accuracy", default.min_accuracy)
    if isinstance(min_accuracy, bool) or not isinstance(min_accuracy, int | float) or not 0 <= min_accuracy <= 1:
        raise ReadingRequestError(f"Reading request {request_id}: asr_check.min_accuracy must be a number in [0, 1]")
    asr_check = AsrCheck(metric=str(check_doc.get("metric", default.metric)), min_accuracy=float(min_accuracy))

    raw_lines = doc.get("lines")
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ReadingRequestError(f"Reading request {request_id}: 'lines' must be a non-empty list")
    lines = []
    for index, item in enumerate(raw_lines, start=1):
        if isinstance(item, str):
            line_id, text = f"{index:04d}", item
        elif isinstance(item, dict):
            line_id, text = str(item.get("id", f"{index:04d}")), item.get("text")
        else:
            raise ReadingRequestError(f"Reading request {request_id}: line {index} must be a string or an object")
        if not isinstance(text, str) or not text.strip():
            raise ReadingRequestError(f"Reading request {request_id}: line {index} has no text")
        if not is_safe_id(line_id):
            raise ReadingRequestError(f"Reading request {request_id}: line id {line_id!r} is not path-safe")
        lines.append(ReadingLine(id=line_id, text=" ".join(text.split())))
    if len({line.id for line in lines}) != len(lines):
        raise ReadingRequestError(f"Reading request {request_id}: duplicate line ids")

    return ReadingRequest(
        id=request_id,
        title=str(doc.get("title") or request_id),
        language=language,
        instructions=str(doc.get("instructions") or ""),
        asr_check=asr_check,
        lines=tuple(lines),
        revision=hashlib.sha256(raw).hexdigest()[:16],
    )


class ReadingRequestCatalog:
    """Request files in one directory, re-read on each lookup so edits apply without a restart."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def ids(self) -> list[str]:
        return sorted(p.stem for p in self.directory.glob("*.json") if is_safe_id(p.stem))

    def load(self, request_id: str) -> ReadingRequest | None:
        if not is_safe_id(request_id):
            return None
        path = self.directory / f"{request_id}.json"
        if not path.is_file():
            return None
        return parse_reading_request(request_id, path.read_bytes())
