# Contribution consent and submission records

Sketched 2026-11-18.

## Outcome

Every stored take carries the permission it was given under, in a form a
downstream user can check mechanically, and contributors can see, limit and
withdraw what they gave. Commissioned speakers are covered by their contract
today; this is needed before anyone records without one.

## Permission profile

A versioned profile, referenced by id from each take's sidecar. Keep the
dimensions independent rather than one privacy slider:

| Dimension | Choices |
| --- | --- |
| Use | private evaluation / training / both |
| Inspection | machine processing only / named human reviewers |
| Recipient | this project / named recipients / a described channel |
| Retention and withdrawal | how long; what withdrawal removes and what it cannot (an already trained model) |

"Machine processing only" must hold everywhere: dashboards, debugging,
support, logs, samples and exports, not just a hidden play button. A
recipient that cannot honor it cannot receive that take. It excludes the
take from human-reviewed evaluation sets.

The profile could become a small reusable standard, like the Creative Commons
licenses in being readable and copyable, but it is a consent and use
contract, not a copyright license; no existing CC license fits personal
recordings. Legal wording is not chosen here.

## Review before release

For collection beyond commissioned reading (spontaneous speech, dictation),
keep takes local to the contributor's account until they select a batch,
review it (audio, text, history), remove excerpts or "everything from the
last N hours", set restrictions and release it. Removing an excerpt removes
it from audio, text, context and metadata alike. A size or time threshold
may suggest a batch; it never uploads one.

## Receipts

Release returns a receipt: manifest, profile version, recipient, accepted
and rejected records, and an idempotency key so a retry neither duplicates
data nor pays twice. Local deletion and downstream withdrawal are separate
operations, and the interface must not suggest withdrawal happened without a
receipt for it.

## Open

- Whether reading requests get a per-request profile chosen by the requester
  and shown to the speaker, or the speaker chooses.
- Legal review of the default profiles.
