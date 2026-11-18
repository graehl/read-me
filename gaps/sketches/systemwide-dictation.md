# Systemwide dictation as a contribution source

Sketched 2026-11-18.

## Outcome

A device-wide speech input method (an Android keyboard or voice input,
desktop dictation on Windows or macOS) that people use for ordinary work in
any application. Dictation is useful to them on its own terms; contributing
the audio and its corrected text is a separate opt-in, and those who want
compensation for it can opt into that.

## Why it is different from reading or review

Routine dictation yields much more natural speech than deliberate
contribution sessions, but less careful review. Without knowing the
application's state, an edit after insertion may repair a recognition error,
change the speaker's mind, or polish style. So:

- record the surface (which app category, input method, what context the
  user chose to provide) and the review actions actually observed;
- "the user sent this text" is weaker evidence than "the user verified this
  transcript against the audio"; no later edit is not evidence of review,
  and edits inside another app are often invisible;
- never fill the gap by monitoring other applications.

## Approach

- Reuse the capture, check and correction pieces of the reading and review
  pages; the input method is another front end.
- Keep dictated takes local until the user reviews and releases a batch
  under a [permission profile](contribution-consent.md); some fields and apps
  (passwords, banking, chosen exclusions) never enter collection.
- Start with one explicit compose-and-send surface if a true systemwide
  adapter needs broad privileges on that platform.

## Personal use first

graehl's own dictation through yepanywhere is a small, already existing
source: English, technical vocabulary, one voice. Collected with its
corrections, it would allow fine-tuning an English recognizer to that voice
and domain. Useful eventually, not urgent; it needs no public service, only
local retention plus the correction labels above.

## Open

- Platform feasibility for each OS: keyboard and input-method APIs, what
  survives focus changes, how to show recording and pending submission.
- Licensing of contributed dictation for others' use, and the opt-in terms
  for compensation ([economics](contribution-economics.md)).
