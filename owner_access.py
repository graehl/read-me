"""Owner access: a password login for browsing every stored take.

Accounts live in `<data>/owner-accounts.json` (never committed), one salted
PBKDF2-SHA256 hash per user name. While that file does not exist, the first
login enrolls: its user name and password become the account. A login is
remembered by an HMAC-signed cookie, keyed by `<data>/owner-cookie-key`, so it
survives a server restart.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

PBKDF2_ITERATIONS = 600_000
COOKIE_NAME = "read-me-owner"
COOKIE_MAX_AGE_S = 30 * 24 * 3600


def hash_password(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations).hex()


class OwnerAccounts:
    def __init__(self, data_root: Path) -> None:
        self.accounts_path = data_root / "owner-accounts.json"
        self.key_path = data_root / "owner-cookie-key"
        self._lock = threading.Lock()

    def log_in(self, user: str, password: str) -> str | None:
        """A session cookie value for valid credentials, else None; enrolls the first login."""
        with self._lock:
            if not self.accounts_path.exists():
                self._enroll(user, password)
            account = json.loads(self.accounts_path.read_text(encoding="utf-8")).get(user)
        if account is None:
            return None
        expected = hash_password(password, bytes.fromhex(account["salt"]), account["iterations"])
        if not hmac.compare_digest(expected, account["hash"]):
            return None
        return self._session_value(user, int(time.time()) + COOKIE_MAX_AGE_S)

    def session_user(self, cookie_value: str | None) -> str | None:
        """The user a session cookie value names, when its signature is valid and unexpired."""
        if not cookie_value or cookie_value.count(".") < 2:
            return None
        user, expires, _ = cookie_value.rsplit(".", 2)
        if not expires.isdigit() or int(expires) < time.time():
            return None
        if not hmac.compare_digest(cookie_value, self._session_value(user, int(expires))):
            return None
        return user

    def _enroll(self, user: str, password: str) -> None:
        salt = secrets.token_bytes(16)
        accounts = {user: {"salt": salt.hex(), "iterations": PBKDF2_ITERATIONS, "hash": hash_password(password, salt)}}
        self._write_private(self.accounts_path, json.dumps(accounts, indent=1) + "\n")

    def _session_value(self, user: str, expires: int) -> str:
        payload = f"{user}.{expires}"
        signature = hmac.new(self._cookie_key(), payload.encode(), hashlib.sha256).hexdigest()
        return f"{payload}.{signature}"

    def _cookie_key(self) -> bytes:
        with self._lock:
            if not self.key_path.exists():
                self._write_private(self.key_path, secrets.token_hex(32))
            return bytes.fromhex(self.key_path.read_text().strip())

    @staticmethod
    def _write_private(path: Path, text: str) -> None:
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        tmp.replace(path)
