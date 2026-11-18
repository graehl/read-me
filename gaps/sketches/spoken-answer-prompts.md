# Spoken-answer prompts

Sketched 2026-11-18.

## Outcome

Unscripted speech without building a game: instead of a line to read, the
speaker gets a prompt to answer in their own words ("describe how to get
from your home to the nearest market", "explain a recipe you know", "argue
for or against X"). A recognizer drafts the transcript and the speaker
corrects it right away, while they still remember what they said.

## Approach

- Request `kind: "answer"`, items are prompts with a target length
  (15–60 s). The prompt is shown, never meant to be read aloud.
- After Stop: the same take checks as reading, then the recognizer draft in
  an editable box; Confirm or Save as in
  [transcript review](transcript-review-tasks.md). The speaker's own
  correction is strong evidence, since they know what they meant to say, but
  keep it labeled as self-corrected rather than independently reviewed.
- Prompts are chosen for the register and vocabulary wanted (colloquial,
  numbers, place names, code-mixed topics), as reading scripts are.
- Record prompt id and version with each take, so the effect of prompt
  wording on what people say is inspectable.

## Open

- Recognizer latency on the page: a local recognizer for the language, or
  defer the draft and show the edit step when it arrives.
- Whether answers may contain personal information about the speaker and
  how that interacts with [consent](contribution-consent.md); prompts should
  steer away from it.
- How this relates to conversation with an AI partner, which is out of
  scope here.
