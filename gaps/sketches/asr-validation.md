# Recognizer validation of takes

Sketched 2026-11-18. Not implemented: requests already carry `language` and
`asr_check`, and nothing reads `asr_check` yet.

## Outcome

Shortly after a take is stored, a recognizer transcribes it and the take's
accuracy against the requested line is shown on that line's chip. The speaker
keeps working; the result arrives when it arrives. A take whose accuracy is
below the request's floor is flagged for retry or review, not discarded.

## The request annotation is required input

Each reading request must say what the check needs; without it the server
should refuse to validate, not guess:

- `language` (required now): selects the recognizer and the scoring view.
- `asr_check.metric`: the error measure to use, e.g. a promoted per-language
  error rate (`ERn`) or plain CER/WER. Accuracy is `1 - error`, clipped at 0.
- `asr_check.min_accuracy`: default 0.2. Lower it, down to 0, for text chosen
  because current recognizers do badly on it (rare names, code-mixed or
  dialect lines); otherwise every good take of such text is flagged.

The floor is deliberately low. It catches the wrong line, silence, a
different language or a badly broken take, not ordinary recognizer error.

## What a low score means

A low score has several causes, and the record should keep them apart:

- the speaker misread or changed words: the audio is good; either record it
  again or correct the line's transcript to what was said (see
  [transcript review](transcript-review-tasks.md));
- the recognizer is weak on this text or speaker: the take is good and the
  score is itself useful evidence;
- the take is bad (noise, clipping, cut off): record again.

The first version should only flag. Later, show the recognizer's text so the
speaker can tell a misreading from a recognizer error, and let a reviewer
mark which cause applied.

## Approach

- A worker (separate process, queue in the data root) picks up new takes,
  runs a pinned recognizer from the shared model directory, and writes
  `<take>.asr.json`: recognizer id and version, raw hypothesis, metric,
  normalization, error, accuracy, pass/flag.
- Never overwrite the raw hypothesis with a corrected one; corrections are a
  separate layer.
- The page learns of results through the progress endpoint it already calls
  after each upload, not a standing poll; a short bounded poll while results
  are pending is acceptable.
- Held-out evaluation requests must use local recognizers only (see
  [private holdout](private-holdout-requests.md)).

## Open

- Which recognizer per language, and whether to run two and keep both.
- Whether a flag should disable Next (as browser check failures do) or only
  warn. Default: warn, since the result may arrive after the speaker moved on.
- Cost on CPU versus GPU for long sessions.
