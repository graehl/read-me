# Speaker accounts and validated work records

Sketched 2026-11-18. Today a speaker is whatever code appears in the link or
setup form, and access control is whatever proxy sits in front of the server.

## Outcome

A speaker signs in once, sees the requests assigned to them, and has a
durable record of validated work: which lines they recorded, which takes were
kept, which passed checks and recognizer validation, and what that work is
worth to them (payment, credit, or nothing, as agreed).

## Approach

- Invitation links per speaker and request, carrying a revocable token;
  signing in binds the token to an account. No passwords to start: link plus
  an emailed or messaged one-time code when the link is reused elsewhere.
- Speaker codes stay pseudonymous in stored takes; the mapping to a real
  person lives in a separate, access-restricted table.
- A work record per speaker and request built from `events.jsonl`: takes,
  accepts, overrides, check and validation outcomes, review outcomes. Paying
  or crediting is computed from accepted, validated work, not raw minutes.
- Requesters (whoever posts a reading list) are a second role: they create
  requests, set the permission profile and validation floor, and see
  progress, not other requesters' data.

## Open

- Identity provider (none, email codes, OAuth through the hosting proxy).
- Whether one person may hold several speaker codes (different devices or
  microphones are better recorded as capture metadata).
- Payment mechanics, which belong with
  [contribution economics](contribution-economics.md).
