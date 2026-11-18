# Private held-out evaluation recordings

Sketched 2026-11-18.

## Outcome

A reading request can be marked as a held-out evaluation set. Its recordings
are new, private, and demonstrably unavailable to the public recognizers they
will be used to evaluate, so test scores do not depend on recycled public
benchmarks that released models may have trained on.

## Approach

- Request field `purpose`: `evaluation-holdout` or `training`, fixed when the
  request is created. Takes inherit it; the two never mix later.
- Record the date and the identities of the checkpoints a set will evaluate.
  A recording made after a checkpoint's release cannot have been in its
  training data; that is a practical boundary for those fixed weights, not a
  promise about future models once the set is shared.
- Track exposure per take: every service that received its audio, transcript,
  corrections or context (recognizers for validation, judges, annotators).
  Remote inference is exposure even when not training; its handling terms
  matter to later claims. Holdout requests use local recognizers only.
- Keep raw recognizer output separate from any correction or context-assisted
  output, and score them as different systems.
- Freeze transcripts and speaker grouping before the set is used for any
  tuning; keep an untouched portion if early results inform development.
- Never use a holdout recording for training, prompt tuning, speaker
  adaptation or vocabulary building, even after it passes through another
  tool.

## Open

- Where held-out audio lives (a separate data root with tighter access).
- Whether the text itself must also be new (unseen by language-model training
  corpora) for some evaluations, as in reading-script selection for test sets.
