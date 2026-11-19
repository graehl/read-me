# read-me

Record speech for speech-recognition training and evaluation from a phone
browser. A speaker opens a link, reads a prerequested list of lines one at a
time, and gets immediate feedback on each recording: levels, clipping, the
pauses before and after speech, a noise gate, and band-limiting from a
Bluetooth or voice-codec path. No app install: the page runs in a current
Chrome on Android or desktop.

Every take is kept on the server, including the ones the speaker retried.
For each line, the take the speaker kept (normally the last plausible one) is
marked accepted; training or evaluation uses that one.

Status: first version. Reading only; recognizer validation, speaker accounts,
consent records and other task kinds are [planned](#planned-work).

## Running

Requires Python 3.11+ (standard library only) and `ffmpeg`.

```bash
./read_me_server.py --port 3470 --data /path/outside/the/repo
```

Open `http://localhost:3470/` for the list of reading requests, or
`/r/<request>?speaker=<code>` for one. The microphone needs a secure origin:
`localhost`, or HTTPS through a reverse proxy or tunnel. The server sets no
access control of its own; put it behind one (a private link proxy, a tunnel
with access rules) before sharing it.

As a [yepanywhere](https://github.com/graehl/yepanywhere) project app,
`.project-template/app.json` starts the server in YA's project sandbox on the
port YA passes as `PORT`. The sandbox can write only inside the project, so
takes go to the Git-ignored `data/` directory there; YA's reserved address
supplies HTTPS and the private-link access check. Open the address directly
in its own tab: the recorder sets `frame-ancestors 'self'` and
`microphone=(self)`, so it does not record inside YA's framed App view.

## Reading requests

One JSON file per request in `requests/` (or `--requests DIR`):

```json
{
  "title": "Demo: five English lines",
  "language": "en",
  "instructions": "Shown above the setup form.",
  "asr_check": {"metric": "ERn", "min_accuracy": 0.2},
  "lines": [{"id": "0001", "text": "..."}, "plain strings get ids 0001, 0002, ..."]
}
```

`language` is required. `asr_check` is stored now and used once recognizer
validation exists ([sketch](gaps/sketches/asr-validation.md)); lower
`min_accuracy` for text known to be hard for current recognizers. Each take
records the request file's hash, so later edits to a request do not
misattribute earlier recordings.

## Storage

Under `--data`:

```
takes/<request>/<speaker>/<line>/<take>.flac   16 kHz mono FLAC
takes/<request>/<speaker>/<line>/<take>.json   line text, request hash, capture
                                               settings, browser checks
takes/<request>/<speaker>/accepted.json        line -> accepted take
takes/<request>/<speaker>/events.jsonl         every take and accept, in order
owners/<owner key>.jsonl                       takes uploaded by one browser
```

The server stores 16 kHz FLAC, the form our recognizers train on, resampled
from the browser's native rate with soxr.

## Capture

The page asks Chrome for unprocessed mono audio and records, per take, what
the browser actually applied (`track.getSettings()`):

- **Echo cancellation off.** On Android Chromium, requesting it selects the
  communication capture path, which processes the signal. Apps that play
  audio while listening need it; this page plays nothing while recording.
- **Noise suppression and automatic gain off.** Both reshape level and
  timbre, and suppression gates the pauses to digital silence. Level is set
  by the input device and distance; a device picker appears when the
  browser offers more than one input.
- **Mono by downmix.** The capture node takes one channel with "speakers"
  interpretation, so a stereo track is averaged rather than cut to its first
  channel.
- **Native sample rate.** No browser resampling; the server resamples.
- **The microphone counts as open only once samples arrive**, with a 3.5 s
  watchdog, so a suspended audio context cannot record silent takes.

Several of these were learned in the dictation capture of
[yepanywhere](https://github.com/graehl/yepanywhere)
(`topics/streaming-speech-capture.md`).

The browser checks were calibrated on real speech: clean 16 kHz read speech
puts the 5–7.5 kHz band about 29 dB below the 0.3–3.4 kHz band; the same clip
low-passed at 5 kHz, or sent through an 8 kHz voice codec, falls to −47 dB or
lower, and the warning fires below −40 dB.

## Recording flow

Record → speak → Stop. The take's waveform appears with the detected speech
span shaded, together with the check results. **Next** keeps the take and
moves on; **Retry** records the line again. Uploading and keeping run in the
background, so moving on never waits; the numbered chips at the top show each
line's state as results arrive (✓ kept, ! kept with a warning, ✕ kept despite
a failed check, ⚠ not saved). A failed check disables Next; "Use this take
anyway" overrides it, and the override is recorded. On desktop: Space
records/stops, Enter keeps, R retries, arrows move between lines.

## Your recordings

`/mine` lists every take recorded in the current browser, as
`<request>.<line>.<NN>.flac`, with single downloads and a zip of all of them
(one folder per speaker code, plus a `takes.tsv` manifest with each line's
text and whether the take was kept). A speaker reaches it from the request
list or from the recorder once all lines are done.

Access uses a random token the page keeps in local storage and sends with
each upload; the server stores only its sha256 hash. Another device, or
clearing the site's data, cannot see those takes, and knowing a speaker code
grants nothing. This is a courtesy until
[speaker accounts](gaps/sketches/speaker-accounts.md) replace it. Takes
uploaded before the token existed are not listed. The zip is built in
memory, which suits sessions of up to a few hundred takes.

## Planned work

Each sketch in [gaps/sketches/](gaps/sketches/) is an independent unit:

| Sketch | Adds |
| --- | --- |
| [asr-validation](gaps/sketches/asr-validation.md) | recognizer check of each take against the line, per-request accuracy floor |
| [private-holdout-requests](gaps/sketches/private-holdout-requests.md) | held-out evaluation sets with exposure tracking |
| [speaker-accounts](gaps/sketches/speaker-accounts.md) | sign-in, invitations, per-speaker record of validated work |
| [contribution-consent](gaps/sketches/contribution-consent.md) | versioned permission profiles, review before release, receipts |
| [transcript-review-tasks](gaps/sketches/transcript-review-tasks.md) | listen and confirm or correct transcripts of spontaneous speech |
| [spoken-answer-prompts](gaps/sketches/spoken-answer-prompts.md) | answer a prompt in your own words, then correct the draft |
| [systemwide-dictation](gaps/sketches/systemwide-dictation.md) | device-wide dictation with opt-in contribution |
| [contribution-economics](gaps/sketches/contribution-economics.md) | value accounting, rewards, demand, a public service |
| [contribution-abuse](gaps/sketches/contribution-abuse.md) | defenses once contribution is rewarded |

## Tests

```bash
python3 -m pytest          # server and storage
node --test 'tests/*.test.mjs'   # recording checks on synthetic takes
```
