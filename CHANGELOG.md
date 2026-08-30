# Changelog

Work lands as scoped commits with descriptive messages, not squashes of weeks.
(The public repo's initial commit is a deliberate exception: 91 private commits
were withheld for privacy, snapshotted, and scrubbed — see the README note.)

## 2026-08-30 — Reviewer wishlist: ADRs, red team, tier-2 evals, cost tracing

- **docs/adr/**: five decision records (hand-rolled agent loop; deterministic
  gates over LLM judges at write time; attribution over sanitization; the
  provenance memory model; task-keyed model routing + cost).
- **Injection red-team corpus** (tier 1, CI): 21 cases across the known attack
  families; 14/14 attacks blocked, 6/6 legitimate saves admitted, 1 boundary
  rejection pinned as an accepted cost.
- **Tier-2 runners**: `eval:scoring` (5 fixture ads vs a student-persona KB,
  band-level expectations) and `eval:generation` (score → generate → the real
  guarded save path with findings-fed retry); CLI or API providers.
- **Cost tracing**: cloud SDK calls emit spans (tokens, latency, dollars from
  a dated price table) to the user's own store; `eval:costs` reports totals
  and per-application cost. Local CLI lane documented as flat-rate/untraced.

## 2026-08-30 — Outcome calibration eval (REQ-13 tier 3)

- `npm run eval:calibration`: the scorer judged against reality — predicted
  bands vs real interview conversion from the live application history, Wilson
  95% intervals, pending censored + conservative rate published, withdrawn
  censored as candidate-choice. Pure logic in `packages/engine/calibration.ts`
  (10 unit tests); aggregate-only output (publishable, no pipeline leakage).
- First published run (52 applied, 22 decided): band ordering MONOTONE —
  STRONG 35% [17–59%] vs COMPETITIVE 0% [0–66%].
- `evals/README.md` seeds the three-tier harness structure (REQ-13).

## 2026-08-30 — Reliability & hygiene batch (review REQ-7, 9, 14, 15, 18)

- **Drive backoff (REQ-7):** every Drive call retries 429/5xx up to 3 attempts
  with exponential backoff + jitter, honoring `Retry-After`; per-project quota
  risk documented in `apps/cloud/SECURITY.md`.
- **Cloud abuse limits (REQ-9):** 256KB JSON body cap and a per-user 10-turns/
  minute in-memory rate limit on all five agent routes (tailor, enrich,
  interview, source, capture).
- **Style policy as configuration (REQ-14):** `checkStyle(text, policy)` with
  the house rules as defaults; cloud users may override via `style-policy.json`
  in their Drive.
- **Registry as data (REQ-15):** the board registry loads from the user's data
  path with the committed file demoted to seed/fallback; staleness (>30 days)
  is warned, never silent.
- **Seam tests (REQ-18):** tailor-agent tool dispatch with a mocked Anthropic
  client (attribution guard, unknown-file and style rejections, turn-1
  injection block, transcript persistence); per-ATS adapter fixture parsing
  including malformed payloads; autofill mapping extraction + option-verbatim
  guard.

## 2026-08-29 — Reliability batch (review REQ-6, 8, 10)

- Sourcing fetch fails loudly: typed outcomes, retry with backoff, per-ATS
  concurrency caps, `fetch_stats` accounting + degraded-sweep banners.
- Model ids centralized into a `TASK_MODELS` registry.
- Cloud lane documented docx-only until the container render path lands.

## 2026-08-29 — Security batch (review REQ-2, 3, 4, 5)

- Attribution guard: KB writes must trace to candidate messages (prompt-
  injection → provenance-poisoning path closed).
- Metric grounding bound to the claimed provenance source, not the whole corpus.
- Autofill endpoints authenticated (Host allowlist + shared token); EEO served
  only on explicit opt-in.
- Encryption-key versioning + rotation for stored Anthropic keys.

## 2026-08-28 — Public snapshot

- Initial public work-sample snapshot (history withheld for privacy), personal
  data scrubbed, all-rights-reserved LICENSE.
