# AGENTS.md

Guidance for agents working in this repository. `CLAUDE.md` is a symlink to
this file.

## What this is

read-me collects speech for speech-recognition training and evaluation from
a phone or desktop browser: a speaker reads prerequested lines and each take
is checked, stored and, when kept, marked accepted. [README.md](README.md)
describes running it, the request format and storage. Intended future work
is in [gaps/sketches/](gaps/sketches/); the project may grow from a reading
recorder into a public contribution service, and those sketches say how.

## Code

- Python: standard library only (server, request loading, take storage).
  Format and lint with `uvx ruff format` and `uvx ruff check`; line length is
  set in `pyproject.toml`.
- Browser: plain ES modules under `static/`, no build step and no
  dependencies. Keep browser-checkable logic (the take checks) as pure
  functions so Node can test them.
- Software-aesthetic coordinated rules apply
  (`~/agents/topics/software-aesthetic.coordinated.md`): validate at the HTTP
  and request-file boundaries, raise there, and trust normalized values
  inside.
- Capture settings in `static/mic-capture.js` are deliberate; its header
  comment records why. Do not turn on echo cancellation, noise suppression
  or automatic gain, or truncate stereo to one channel, without new evidence.
- Tests: `python3 -m pytest` and `node --test 'tests/*.test.mjs'`. A change
  to capture or the recording page also needs a browser run with a fake
  microphone (Chrome `--use-file-for-fake-audio-capture`) and inspected
  captures at 1200×600 and 375×812.

## Data

Recordings are personal data. Never commit audio, takes, speaker codes or
data-root paths that identify a person. Every take is kept on the server,
including retried ones; nothing in this repository deletes takes, and a
cleanup tool needs the owner's explicit approval of what it removes.
