# Abuse resistance for rewarded contribution

Sketched 2026-11-18. Needed only once contribution is rewarded and open to
the public; invited or commissioned speakers need provenance records, not
these defenses.

## Threats

- Synthetic or replayed audio, including text-to-speech of the requested
  lines and resubmitted takes.
- Stolen or recycled recordings and transcripts.
- Rubber-stamp review: confirming drafts without listening, or automated
  reviewers.
- Account farms and agent swarms harvesting rewards or subsidized model
  access.
- Collusion between contributors and data consumers who rate them.
- Not abuse but still a budget problem: sincere users whose consumption of
  subsidized models exceeds the value of their contributions.

## Defenses

- Bounded trial budgets and delayed reward settlement, so fraud is caught
  before payout.
- Deduplication of audio (fingerprints) and text across all contributors;
  provenance checks on capture metadata.
- Seeded known-answer review items and sampled second review, within what
  the take's [permission profile](contribution-consent.md) allows; a
  machine-only take cannot silently become a human audit sample, so
  channels needing human audit admit only takes that permit it.
- Consistency checks within a session (voice, device, room), and analysis at
  cohort level rather than per take.
- Consumer acceptance of delivered data, with appeals.

Do not rely on a universal synthetic-speech detector, published score
thresholds, or one identity check. Keep fraud handling separate from
ordinary budget limits: a low-yield user is not presumed malicious. Balance
every defense against accessibility: accents, unusual voices and unpolished
speech are wanted, not suspicious.

## Open

- Which provenance signals the browser can supply without invasive
  fingerprinting.
- Appeal process and who staffs it.
