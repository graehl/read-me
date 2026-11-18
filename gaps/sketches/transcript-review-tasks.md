# Transcript review tasks

Sketched 2026-11-18.

## Outcome

A second task kind beside reading: a contributor listens to a short stretch
of speech, usually spontaneous, and confirms or corrects its transcript.
Reviewed spontaneous speech is the more valuable data; reading supplies
coverage of chosen text, review supplies labels for speech nobody scripted.

## Task

- A review request lists utterances (audio reference plus a draft transcript
  from a recognizer, a caption or an earlier reviewer) instead of lines to
  read. Same request file family, `kind: "review"`.
- The page reuses the waveform and playback of the reading page: play,
  replay a selected span, edit the text, then Confirm (no change needed) or
  Save (changed). Skip and "can't tell" are valid outcomes.
- The same flow fixes a reading take whose speaker misread the line: the
  draft is the requested line, and the reviewer edits it to what was said.

## What to record

Keep evidence kinds separate; they are not equally reliable:

| Label | Meaning |
| --- | --- |
| unreviewed | recognizer or caption output only |
| confirmed | a person listened and accepted the draft unchanged |
| corrected | a person changed it; keep both texts and the edit |
| skipped / unclear | listened, could not or would not decide |

Record what the reviewer actually did (played the whole utterance or not,
time spent), not an assumption that they checked every word. A correction of
recognizer error is different from rewording for style or intent; ask
reviewers to transcribe what was said, and keep any intended-meaning edit
separate.

## Quality control

Seed known-answer items, and send a sample to a second reviewer. Agreement
with a recognizer does not prove careful review. Corrections per minute is
not a target: clean speech needs none.

## Open

- Where review audio comes from (our own corpora, contributors' dictation,
  partner data) and its permission profile
  ([contribution consent](contribution-consent.md)).
- Span-level editing with alignment versus whole-utterance text editing.
