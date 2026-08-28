# Kairos Sourcing v1 + Cost Ledger — Spec

Status: DRAFT v2 for review · 2026-07-28 (v2 same day: self-sufficiency scope after seed research)
Owner: Boris Nicolas · Drafted with Claude
Related: `kairos-spec-v2.md` (local lane), `kairos-cloud-lane-spec.md` (cloud lane)

## 1. Goal

Sourcing must be **self-sufficient**: good enough that a student who has never
run a job search can use Kairos as their only discovery tool. Kairos deduces
what to look for from the knowledge base and profile, sweeps a wide company
universe on demand, and fills a **Sourced** column on the board with ranked,
honest candidates. The user promotes cards into the real pipeline with a click.

**Acceptance test (the backtest):** run against the auto-deduced pilot criteria
(target metro or Remote · senior product roles ·
AI-weighted), the pipeline must independently surface the batch of 16 jobs he
hand-collected on 2026-07-28 — minus only those on ATSs with no public feed
(measured target: ≥14/16; the two misses sit on closed systems).

North star (out of scope for v1): auto-filling application forms.

## 2. Non-goals for v1

- No HTML scraping and no ToS-violating sources (no LinkedIn/Indeed).
- No auto-capture: nothing enters Draft without a click.
- No scheduled/background runs (v1.1); runs are on-demand.
- No proactive notifications.

## 3. Coverage research (2026-07-28)

Every major ATS exposes a public, unauthenticated JSON feed — not just the
three we planned. Adapters, in priority order for the backtest:

| ATS | Public feed | Backtest jobs it covers |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true` | SecurityScorecard, Klaviyo, Stripe, Anthropic, Workato, Sureify, Pinterest, Elastic (8) |
| Ashby | `api.ashbyhq.com/posting-api/job-board/<slug>` | Suno, ClickUp, Harvey (3) |
| Workday | POST `{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` (paginated, searchText + facets) | Clio (1) |
| Rippling | `api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` (official job-board API) | Origin, Rippling (2) |
| Lever | `api.lever.co/v0/postings/<slug>?mode=json` | — (common elsewhere) |
| SmartRecruiters / Recruitee | public JSON, v1.1 adapters | — |

Not coverable without scraping: bespoke enterprise ATSs (in-house bank portals, Phenom-hosted career sites). Documented as a known coverage boundary and
handled by the paste-a-link flow that already exists.

Note custom career domains still resolve to these feeds (Pinterest and Elastic
are Greenhouse-backed; the `gh_jid` query param is the tell). The normalizer
must detect ATS by URL *shape and params*, not domain.

## 4. The company universe (self-sufficiency layer)

Board-following alone cannot discover NEW companies — the core of the request.
Hard constraint (pilot user, 2026-07-28): **free by design** — no paid datasets, no
paid or commercial intermediaries, for us or for students. We build our own
tools instead. Three-part universe, all feeding one `registry`:

1. **Bundled seed registry, self-harvested** (ships with Kairos): a
   `build-registry` tool queries the **Common Crawl URL index** (free, public,
   nonprofit web-crawl dataset) for the fixed URL shapes of the five ATSs
   (`boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`,
   `jobs.ashbyhq.com/<slug>`, `<tenant>.wdN.myworkdayjobs.com`,
   `ats.rippling.com/<slug>`), extracts candidate slugs, **validates each
   against the ATS's own public feed** (one probe request; dead/renamed boards
   drop out), and emits `registry.json` with {company, ats, slug, job_count,
   validated_at}. Expected yield: tens of thousands of verified boards at zero
   cost. Committed to the repo as versioned data; re-harvested quarterly.
2. **User-grown entries**: every URL a user pastes anywhere in Kairos (capture,
   sourcing) adds {company, ats, slug} to their personal registry overlay.
   Dismissals never remove a company, only mark postings seen.
3. **Future, optional, off by default**: free-tier aggregator APIs as an
   enrichment tap — only if the backtest ever shows direct-feed coverage
   failing, and never as a required dependency.

## 5. The derived search profile (deduced, then editable)

Built automatically — the student never writes a query:

- **Titles/seniority**: from `profile.md` target_roles + KB title trajectory
  (e.g. Principal/Group/Staff/Director + Product) → expansion table of synonyms
  per seniority band (career-stage-aware, reusing `careerStage()`).
- **Domains**: KB domain frequencies (e.g. AI/LLM/agentic weighting).
- **Locations**: profile location + remote; students default to campus metro +
  remote + open-to-relocate toggle.
- Rendered as **editable chips** above the first run ("Looking for: Principal ·
  Group · Director × Product · AI-weighted · Metro / Remote") — deduction is
  the default, never a cage. Persisted to `sourcing/search-profile.json`;
  regenerated on KB change with user edits preserved.

## 6. The run pipeline (on-demand, best-in-class, still not a swarm)

Named steps, strict contracts, deterministic wherever possible; parallel
fan-out across boards and aggregators; model calls only where judgment lives.

```
derive-profile (deterministic + cached)
  → sweep (parallel, incremental)     registry boards w/ per-board fetch cache (ETag/date; skip boards fetched <20h ago unless forced)
                                      + aggregator queries from the search profile
  → normalize (deterministic)         one Posting shape across 6 ATS schemas + aggregators
  → dedupe (deterministic)            vs applications index, vs sourcing/seen.json, cross-source by URL→canonical + company+title fuzz
  → prefilter (deterministic)         title/seniority/location match vs search profile; recency window (≤45d); cap 150 survivors
  → triage (batched, cheap tier)      SHORTLIST/SKIP + guess_band + one_liner, KB index map as context
  → rank (deterministic)              guess_band, then domain-fit, then recency
  → Sourced column (UI)               top ~25; the rest counted ("+38 more, weaker fits")
  → capture+score (existing pipeline) only on click; max_full_scores batch cap
```

Sweep scale: a few thousand board fetches is minutes of wall-clock with
concurrency ~20 and the 20h cache; local lane free, cloud within serverless
limits by batching boards per invocation. Triage on ~150 survivors ≈ one
batched cheap-tier call (~$0.05–0.10 cloud).

## 7. UX — the Sourced column

New **leftmost board column: "Sourced"**, before Draft, on both lanes.

- Cards render from `sourcing/last-run.json` (NOT the applications index — the
  index stays reserved for things the user chose): company, title, location,
  guess-band badge (visually distinct from real score badges — it's a guess),
  one-liner, source tag.
- Card actions: **Score it** (capture+score → card moves to Draft as a real
  application) · **Dismiss** (→ seen.json).
- Column header: Run button + "last run 2h ago" + chip row of the derived
  search profile; batch action "Score top N".
- Board search includes sourced cards.
- Empty state (pre-first-run): one-line pitch + Run button — this column is the
  student's front door to the whole product.

## 8. Storage

```
sourcing/search-profile.json   derived criteria + user edits
sourcing/registry-overlay.json user-grown {company, ats, slug} additions
sourcing/fetch-cache.json      per-board {etag?, last_fetched, last_count}
sourcing/seen.json             { canonical_url: { verdict, at } }, pruned 180d
sourcing/last-run.json         ranked shortlist the Sourced column renders
packages/engine/sourcing/registry.json   bundled seed registry (shared, versioned)
```

## 9. Cost ledger + header counter

Unchanged from v1 draft, now load-bearing for sourcing:

- `usage.json` append-only events `{ at, lane, module, model, input_tokens,
  output_tokens, est_usd }`; module includes `sourcing-triage`.
- Cloud: instrument the single Anthropic client wrapper (real usage × price
  table); header chip "$X this month"; Settings breakdown + CSV export
  (university-credit reporting substrate).
- Local: token counts only, `est_usd: null` (Max-billed; never invent dollars).
- Sourcing shows projected triage cost before the run and actual after.

## 10. Build order

1. **Ledger core** (ships alone).
2. **Adapters + normalizer** (Greenhouse, Ashby, Lever, Workday, Rippling) —
   pure functions over fixture JSON; the 16-job backtest as a vitest suite.
3. **Seed registry build** (one-time purchase + curation; committed as data).
4. **Derive-profile + prefilter + dedupe** (deterministic, tested).
5. **Triage + rank** contracts.
6. **Sourced column, local lane** — dogfood on the pilot live search; run backtest.
7. **Cloud lane** (pre-run estimate, ledger chip, serverless batching).
8. v1.1: scheduled runs + digest; SmartRecruiters/Recruitee adapters;
   aggregator-driven registry growth loop hardening.

## 11. Resolved defaults (pilot user, 2026-07-28)

- Registry-first universe with aggregator taps; seed registry bought+curated.
- Search profile deduced from KB/profile, editable chips, persisted.
- Sourced column leftmost on the board, both lanes.
- Runs on demand only; 20h per-board fetch cache; recency window 45 days.
- `max_full_scores` 5 per batch click; nothing auto-captures.
- Backtest = acceptance gate before cloud rollout.

## 12. Open questions

- **Q1 — RESOLVED (2026-07-28):** free by design. Seed registry is
  self-harvested from the Common Crawl URL index + feed-validated; no paid
  datasets, no commercial intermediaries. Aggregators dropped from v1.
- **Q2 — Sourced column on mobile-width cloud:** 5 columns get tight; collapse
  Sourced into a drawer below ~900px, or keep 5 and scroll?
- **Q3 — registry size vs sweep time:** a tens-of-thousands registry makes a
  full sweep heavy (minutes local; batched invocations on cloud). Default to
  sweeping a profile-relevant subset (registry entries whose recent postings
  match the derived domains), full sweep behind a "deep run" option?
