# Kairos — Specification: Local Lane (Claude-as-driver, local, Max-billed)

**Status:** Authoritative for the **local lane** (shipped v0/v1). The **cloud lane**
(hosted, multi-tenant, Google Drive + Claude API — what this doc calls the
"student lane / v2" in §11–§12, §15) now has its own authoritative build spec:
**`kairos-cloud-lane-spec.md`**. Naming, settled: two *lanes* over one engine, not
"v1/v2 architectures" — the local lane (here) and the cloud lane (that doc).
**Date:** 2026-07-06 (cloud-lane cross-links added 2026-07-07)
**Archived / reference (do not build from, kept for history):**
`requirements.md` (original v1 spec), `build-brief.md`, `drive-architecture-v1.md`,
`kairos-local-v1.md` (pivot sketch — folded into this doc). Still-live reference
material: `ats-scoring-engine-v1.md`, `generation-engine-v1.md`, `kb-schema-v1.md`
(the prompts/schemas we reuse verbatim).

---

## 1. What Kairos is (unchanged vision)

An **authenticity-preserving career representation engine**. It generates
job-tailored resumes, cover letters, and application answers from a structured
knowledge base of the user's *real* experience, with honest three-axis scoring
(match + authenticity + parse-safety) and strict anti-fabrication. It is **not**
a keyword-stuffing ATS optimizer. Every claim it produces traces to a
provenance-tagged fact the user actually supplied.

**Non-negotiables (invariant across all versions):**
- **N1 — No fabrication.** Unverified facts (`[?]`) never reach any reasoning
  step. Nothing is invented; every output claim traces to `[R]/[C]/[F]` evidence.
- **N2 — Honest scoring.** Bands, never fake-precise percentages. Gaps named
  plainly.
- **N3 — Learning is explicit for facts.** New facts require user confirmation
  (`[C]`) before entering the KB. Style/voice may be learned silently but is
  always reviewable.
- **N4 — The user owns their data.** All personal data lives in local files the
  user controls; nothing personal is sent to any server we run.
- **N5 — House style on ALL generated text.** Every piece of candidate-facing
  text Kairos generates (résumé, cover letter, application answers, and anything
  added later) must read as human-written, not AI-generated. The shared
  anti-AI-tell standard lives in `lib/prompts/voice.ts` (`houseStyle(mode)`) and
  is composed into every generation system prompt — never re-specified per
  prompt. Core bans: em dashes, "not just X but Y", tricolon stacking, buzzwords
  (leverage/robust/spearheaded/…), uniform rhythm. Applies to generated text
  only, never to extraction (which faithfully preserves the candidate's words).

## 2. The architecture inversion

**v1 (parked):** Kairos is the app; it calls Claude via the metered Anthropic
API as a subroutine.

**v2 (this doc):** **Claude Code is the app/workspace**; Kairos is the backend,
memory, and dashboard it drives. Reasoning (extract / score / generate / discuss)
is just Claude doing a task inside the host → **zero marginal token cost** on the
owner's **Claude Max** plan.

**Why not bridge the API from a server (settled — do not retry):** Claude Code's
Max OAuth credential is macOS-Keychain-gated to genuine interactive processes. A
server/subprocess gets `401 Invalid authentication credentials` (even `claude -p`
directly). Using subscription auth to power an automated backend also crosses the
subscription→API ToS line. Hence we flip who drives rather than smuggle auth.

## 3. The three surfaces

| Surface | Role | Tech |
|---|---|---|
| **Claude Code** + `/kairos` skill | **Workspace** — analyze, discuss, clarify, generate. Flat-rate reasoning. | Claude Max, a skill |
| **Kairos MCP server** | **Backend** — file I/O, PDF parse/render, storage, and the deterministic guarantees. | Local Node stdio MCP process |
| **Web app (repurposed)** | **Memory/dashboard** — renders scorecards, saved ads, the application archive from the same files. Read-mostly. | Next.js, reading `~/Kairos/` |

```
Claude Code (Max, DRIVER) ──MCP(stdio)──▶ Kairos MCP server ──▶ ~/Kairos/ (files)
        │  reasoning, flat-rate                 │  guarantees            ▲
        └── /kairos skill                       └── strip [?], validate  │
                                                                         │
                          Local web dashboard ── reads/renders ──────────┘
```

Chat moves into Claude, so the old `ChatPanel` retires; `Dashboard`,
`Scorecard`, and `Workspace` become **viewers** over local files.

## 4. Decisions locked (2026-07-06)

- **D1 — Driver:** Claude Code + local web dashboard.
- **D2 — Storage:** local `~/Kairos/` folder. No Drive, OAuth, or Supabase in the
  personal lane (all parked for the future student lane).
- **D3 — Repo layout:** one repo holds both frontends over the shared `lib/`
  engine — MCP server under `mcp/`, skill under `.claude/skills/kairos/`.

## 5. Storage model (the memory)

All state is human-readable files under `~/Kairos/` (path overridable via
`KAIROS_HOME`). Markdown for anything the user might read/edit; JSON for machine
state.

```
~/Kairos/
  profile.md              identity, target roles, preferences, deal-breakers   [NEW]
  voice-profile.md        learned writing style (grows with edits)
  insights.md             distilled patterns — the "gets smarter" layer         [NEW]
  knowledge-base/
    experiences/NN-company-role.md   [R]/[C]/[F]-tagged; frontmatter + body
    education/*.md
  qa-bank/                reusable application-question answers                  [NEW]
    _index.json           canonical-question -> entry map (for reuse matching)
    q-<slug>.md           question, answer, provenance, source app, topics
  applications/
    YYYY-MM-DD_company_role/
      snapshot.md         saved ad copy — written FIRST (§26)
      score.json          versioned: [v1 initial, v2 improved] + strengths/weaknesses
      resume.md / resume.pdf
      cover-letter.md / cover-letter.pdf                                        [NEW]
      questions.json      the ad's extra questions + the user's answers         [NEW]
      conversation.json   the working discussion (session continuity)           [NEW]
      meta.json           status, dates, docs actually sent, score-band history
  _index.json             cross-application dashboard index
```

### 5.1 Key file schemas

**`profile.md`** (frontmatter + prose):
```yaml
name, contact_line, target_roles: [], target_seniority, domains: [],
preferences: { remote|hybrid|onsite, locations: [], comp_floor?, ... },
deal_breakers: []
```

**Experience file** — unchanged from `kb-schema-v1.md`: frontmatter (id, company,
title, title_normalized, start/end, seniority_level, domains, scope{value,prov},
skills[{name,proficiency,recency,prov}], keywords) + markdown body with
`[R]/[C]/[F]`-tagged bullets. `[?]` may exist in a "Raw material / notes" section
and is stripped before any reasoning.

**`qa-bank/q-<slug>.md`**:
```yaml
canonical_question: "Why do you want to work here?"
topics: [motivation, company-fit]
answer: "... [C]"           # provenance-tagged
prov: C
source_app: 2026-07-06_stripe_staff-pm
reusable: true
```

**`score.json`** (versioned):
```json
{ "versions": [ { "v": 1, "at": "...", "report": <ScoreReport>,
                  "strengths": ["..."], "weaknesses": ["..."] },
                { "v": 2, "at": "...", "report": <ScoreReport>, ... } ] }
```
`<ScoreReport>` = the existing `lib/types.ts` shape (parse_safety, match{bands},
authenticity, gaps, reachable, recommendation).

**`questions.json`**: `[{ question, answer, prov, reused_from?: qaBankSlug }]`

**`meta.json`**: `{ id, company, role, source_url?, status, created_at,
applied_at?, docs_sent: [], score_band_history: [{v, band, at}] }`

**`_index.json`**: array of lightweight entries for the dashboard
`{ id, company, role, status, latest_band, created_at, applied_at? }`.

## 6. The memory & learning system

### 6.1 The Session Brief (linchpin of cross-session memory)

Every session, the skill's **first action** is `load_context()`. The backend
assembles a compact digest so Claude starts *warm* rather than re-reading a cold
prompt:

```
{ profile,
  kb_map:            [{ file, company, title, dates, domains, top_skills }],  // index, not bodies
  voice_summary,
  insights:          ["targeting Principal PM in AI", "recurring gap: ..."],
  qa_index:          [{ canonical_q, topics, last_used }],
  recent_applications:[{ id, company, role, status, latest_band, date }],
  open_threads:      ["unconfirmed fact from last session: 'led team of 20'"] }
```

Full bodies load on demand (`read_experience`, `read_qa`, `read_application`).

### 6.2 How it gets smarter (three compounding layers)

1. **Additive** — every confirmed `[C]` fact, answered question, and completed
   application accumulates as raw material.
2. **Distilled** — `synthesize_insights()` periodically rewrites `insights.md`
   (targeting patterns, recurring gaps + best reframings, what wins callbacks).
   Claude does it → flat-rate. This is the compounding intelligence.
3. **Feedback** — recruiter `[F]` notes and outcomes (callback/reject) feed back
   into scoring emphasis over time.

### 6.3 Provenance model (unchanged, enforced harder)

`[R]` from-resume · `[C]` user-confirmed · `[F]` recruiter-feedback · `[?]`
unverified (**never** usable in reasoning). `stripUnverified()` now runs *inside*
the evidence-fetch tools, so Claude structurally never receives a `[?]` fact.

## 7. User journey (end to end)

Application lifecycle:
```
DISCOVERED → SCORED → IMPROVING → DRAFTED → SENT → (OUTCOME)
```
Statuses: interested · scored · tailoring · ready · applied · interviewing · closed.

| # | Step | What happens | Stored |
|---|---|---|---|
| 0 | **Onboard (once)** | Upload resume → Claude extracts KB (all `[R]`), builds voice profile, and captures target roles/preferences. | experiences/*, education/*, voice-profile.md, profile.md |
| 1 | **Share a job** | User pastes a URL or text into Claude. Backend captures + snapshots the ad first (§26), returns an appId. | applications/<id>/snapshot.md, meta.json |
| 2 | **Analyze & score** | Claude scores three axes and names **strengths & weaknesses**; dashboard renders the scorecard section with the saved ad. | score.json (v1) |
| 3 | **Improve (discuss)** | Claude asks clarifying questions (do you have experience bridging gap X?) and suggests honest reframings. Confirmed facts → `[C]` → KB grows → **re-score** (v2). | experiences/* (updated), score.json (v2), conversation.json |
| 4 | **Generate resume** | Claude generates a tailored, fabrication-safe resume grounded only in stripped evidence, with a provenance audit; renders PDF. | resume.md, resume.pdf |
| 5 | **Cover letter / questions** | Claude offers a cover letter, and for each extra question in the ad checks the **Q&A bank** for a prior answer to adapt (or asks the user). | cover-letter.*, questions.json, qa-bank/* |
| 6 | **Send & validate** | User applies off-platform, then confirms what was sent. App is archived with initial + improved score, all docs, and date. | meta.json (status=applied, docs_sent, applied_at) |
| 7 | **Reuse & learn** | Answers persist in the Q&A bank for future ads; insights synthesize across applications. | qa-bank/*, insights.md |

## 8. Functional requirements

**Onboarding**
- FR-1 Extract a structured KB from an uploaded resume PDF; every fact `[R]`.
- FR-2 Build an initial voice profile from the resume.
- FR-3 Capture candidate profile: identity, target roles, preferences,
  deal-breakers.

**Job capture**
- FR-4 Accept a job by URL (best-effort fetch) or pasted text.
- FR-5 Write the ad snapshot **before** any scoring/generation (§26), even if the
  user abandons.

**Scoring**
- FR-6 Produce the three-axis report (parse-safety authoritative; match banded;
  authenticity detector-aware) using the `ats-scoring-engine-v1` method.
- FR-7 Surface explicit **strengths and weaknesses** for the dashboard.
- FR-8 Score only from **stripped** evidence (no `[?]`).
- FR-9 Support **re-scoring**; persist versioned scores and band history.

**Improvement loop**
- FR-10 Claude asks clarifying questions to surface uncaptured experience.
- FR-11 New facts require explicit confirmation → `[C]`; then available to
  re-score/generate.
- FR-12 Suggest only **honest reframings** of real evidence (from
  `reachable.from_reframing`), never fabrication.
- FR-13 Persist the working conversation per application.

**Generation**
- FR-14 Generate a tailored resume grounded only in `[R]/[C]/[F]` evidence, with
  a `provenance_audit`.
- FR-15 Voice-consistent with the profile; parse-safe single-column output.
- FR-16 Render to PDF locally.

**Cover letter & application questions**
- FR-17 Generate an optional cover letter grounded in the same evidence + voice.
- FR-18 Detect the ad's additional questions; answer by reusing/adapting Q&A-bank
  entries or asking the user.
- FR-19 Persist answers to the Q&A bank with canonical-question indexing for
  reuse.

**Close & archive**
- FR-20 Mark applied with date + which docs were actually sent.
- FR-21 Dashboard shows each application with ad, resume, cover letter, Q&A, and
  initial-vs-improved score.

**Memory & learning**
- FR-22 `load_context` returns the Session Brief at session start.
- FR-23 `synthesize_insights` distills cross-application patterns into
  `insights.md`.
- FR-24 Record recruiter feedback as `[F]`.

**Dashboard (viewer)**
- FR-25 Render the application index, per-application detail, scorecard (with
  v1→v2 delta), and documents from local files. Read-mostly.

## 9. MCP tool surface (contracts)

All tools operate on `~/Kairos/`. Guarantee-enforcing tools marked ★.

| Tool | Input | Output | Notes |
|---|---|---|---|
| `load_context` | — | Session Brief (§6.1) | first call each session |
| `read_experience` | fileName | experience md | on-demand body |
| `read_qa` | slug | qa entry | on-demand |
| `read_application` | appId | meta+score+docs paths | on-demand |
| `extract_resume_text` | pdfPath | { text } | unpdf; deterministic |
| `save_experience` ★ | fileName, frontmatter, body | ok | rejects untagged facts |
| `save_profile` | profile fields | ok | writes profile.md |
| `save_voice_profile` | markdown | ok | |
| `capture_job_ad` ★ | { url? \| text, company?, role? } | { appId } | snapshot-first (§26) |
| `get_scoring_evidence` ★ | appId | { jobText, experiences(STRIPPED), education, voice, qaIndex } | runs stripUnverified |
| `save_score` | appId, report, strengths, weaknesses | { version } | versioned + band history |
| `get_generation_evidence` ★ | appId | { strippedEvidence, reframing, voice, candidate } | runs stripUnverified |
| `save_resume` ★ | appId, markdown | ok | may re-check provenance |
| `render_pdf` | appId, which:resume\|cover | { pdfPath } | puppeteer local |
| `generate_cover_letter` | appId (evidence via tool) | (Claude drafts; save via save_cover_letter) | v1 |
| `save_cover_letter` | appId, markdown | ok | v1 |
| `search_qa_bank` | question | [{ slug, canonical_q, answer, score }] | reuse matching, v1 |
| `save_qa` | appId, question, answer | ok | writes questions.json |
| `upsert_qa_bank` | canonical_q, answer, topics | { slug } | reusable store, v1 |
| `confirm_fact` ★ | fileName, fact | ok | appends `[C]` |
| `record_recruiter_feedback` | fileName, feedback | ok | appends `[F]` |
| `mark_applied` | appId, { docsSent[], date } | ok | status=applied |
| `set_status` | appId, status | ok | |
| `synthesize_insights` | (context via tool) | (Claude writes; save via save_insights) | v1 |
| `list_applications` | — | index entries | dashboard feed |

## 10. Guarantees & enforcement

| Guarantee | Enforced where |
|---|---|
| No `[?]` reaches reasoning (N1) | `get_scoring_evidence` / `get_generation_evidence` run `stripUnverified` in code |
| Every output claim traceable (N1) | `save_experience` / `save_resume` provenance validation |
| Snapshot-first (§26) | `capture_job_ad` writes before returning appId |
| Bands, not fake % (N2) | `/kairos` skill instruction (soft) |
| Facts confirmed, never silent (N3) | `confirm_fact`; skill surfaces candidates |
| Data stays local (N4) | local-fs only; no network egress of personal data |

## 11. Reuse / build / park

- **Reuse (~90%):** `lib/kb/*` (parse, **stripUnverified**, rag, index-map),
  `lib/ingest`, `lib/resume-render`, `lib/pdf`, `lib/prompts/*` (→ skill text),
  `lib/applications`, `lib/types`. React `Dashboard`/`Scorecard`/`Workspace` →
  viewers.
- **Build:** `lib/store/` storage interface + `local-fs.ts`; `mcp/` server;
  `.claude/skills/kairos/`; new memory tools (profile, qa-bank, cover letter,
  questions, conversation, insights); dashboard local-read path; v1↔v2 score
  delta UI.
- **Park (student lane, v2):** `auth.ts`, `lib/supabase`, `lib/crypto`,
  `lib/config`, `lib/claude.ts` (API caller), `lib/providers/claude-cli.ts`,
  `app/api/*`, `ChatPanel`, Google OAuth publish.

## 12. Build order

- **v0 — prove the loop:** storage interface + `local-fs` → MCP server (§9 core
  tools) → `/kairos` skill. Onboard → capture → score → generate → PDF, entirely
  in Claude Code, flat-rate.
- **v1 — memory + polish:** Session Brief, qa-bank + reuse, cover letters,
  application questions, conversation persistence, insights synthesis, dashboard
  wired to local store with v1↔v2 deltas.
- **Cloud lane (formerly "v2 student lane"):** reactivate API/Drive/Supabase as a
  hosted frontend over the same engine (BYO per-user keys, server-side agent loop,
  OAuth publish). **Now specified in full in `kairos-cloud-lane-spec.md`** — build
  from there, not from this bullet.

## 13. Open questions / risks

- **R1 — URL fetch robustness.** Many job sites are JS-heavy/blocked;
  `fetchJobAd` is best-effort. Mitigation: paste-text fallback; Claude Code's own
  web fetch as a backstop.
- **R2 — Reasoning-format consistency.** Without a fixed API call, output shape
  depends on the skill. Mitigation: strong skill instructions + JSON-schema
  validation in `save_*` tools (reject malformed, ask Claude to retry).
- **R3 — PDF rendering locally.** Reuse `lib/pdf.ts` local-Chrome path; validate
  on this machine.
- **R4 — Skill ↔ MCP coupling.** Tool names/contracts must stay in lockstep with
  skill instructions; treat §9 as the contract of record.

## 14. Glossary

- **§26** — job-ad capture writes the snapshot to storage *first*, before scoring
  or generation, even if the user abandons.
- **§22** — the learning loop: facts are never silent; chat surfaces candidates,
  the user confirms `[C]`.
- **Session Brief** — the compact context digest `load_context` returns each
  session (§6.1).
- **Provenance tags** — `[R]` resume · `[C]` confirmed · `[F]` feedback · `[?]`
  unverified (never used).

## 15. Résumé Health Check (job-agnostic quality report)

A quality report on the knowledge base **itself**, independent of any job —
distinct from the job-specific three-axis score (§7/§8). It answers "how good is
this résumé on its own," which is exactly what **onboarding** needs, since a new
user has no job to score against yet. Inspired by the format of commercial
reviews (Ladders et al.): a granular per-dimension rubric, evidence-linked, with
one concrete fix each. Deliberately **honest**: every "fix" is a Kairos action
(enrich this role, rewrite this bullet, tighten this summary), never an upsell;
no fabricated percentiles; no ATS fear-mongering.

### v0 (BUILT, local)
`lib/health.ts` `computeHealth(experiences, {contactLine, headline})` →
`HealthReport`. **Deterministic** (so it is trustworthy, not vibes). Dimensions,
each scored 0–5 and grouped:
- **Mechanics:** contact completeness · headline/positioning · structure &
  recency (reverse-chron + detail gradient).
- **Content:** quantified-impact density (% of bullets with a number) ·
  **weak/vapor-bullet detector** (flags vague, outcome-free bullets — the
  "Agent-platform primitives" problem) · action verbs (weak openers, power-verb
  clustering).
- **Authenticity:** AI-tells scan (em dashes + buzzwords) — the house-style rules.
- **Depth (Kairos-unique):** provenance mix `[R]` vs `[C]/[F]`; thin résumé-only
  roles routed to enrichment.
Output: overall /100 + verdict, per-dimension score/detail/evidence/fix, a
prioritized **top-3 fixes**, and a **flagged-bullets** list. Surfaced at `/health`
(report page) + a home card; exposed as MCP tool `resume_health_check`. The two
genuinely-differentiated pieces (which no rewrite-seller can do) are the
**vapor-bullet detector** and the **provenance-depth** score.

### v2 (cloud lane — Google Drive + Claude API)
The deterministic core stays authoritative and shared. v2 augments it with a
**reasoned pass** (Claude API, metered per student key) that catches what regex
can't:
- **Semantic vapor detection** — subtle vagueness the heuristic misses.
- **Summary scannability & headline specificity** — graded, with a concrete rewrite.
- **Bullet outcome-vs-activity** — does each bullet show a result, not just a task.
- **Per-weakness rewrite suggestions** — Claude proposes a stronger bullet
  grounded ONLY in KB evidence; the user confirms → stored `[C]` (never fabricated).
- **Onboarding as the hook (FR-NEW):** after résumé upload → extract KB → run the
  health check → present the report as the **first-run deliverable** → route
  straight into the enrichment interview for thin/weak roles. Turns a passive
  upload into an active first session (critical for student adoption).
- **Health over time** — cache reports in Drive; show the score improving as the
  user enriches (a progress loop, honestly earned).
- **Honest benchmarking (optional, guarded)** — if percentiles are ever shown they
  must be computed from a real anonymized corpus, never invented. Default: none.

**Guardrails:** deterministic core is the source of truth; the reasoned pass only
augments; all rewrite suggestions are proposals requiring `[C]` confirmation;
nothing is fabricated. Storage: report cached alongside the KB (local file in v0,
Drive in v2).

## 16. Future ideas (captured, not scheduled)

- **Base-résumé workspace.** A section to view and improve a single "default"
  résumé independent of any application (edit bullets, run the health check, fix
  vapor bullets, enrich roles) — the canonical résumé the per-job tailorings
  branch from. Distinct from the per-application résumés.
- **Template upload (v2).** Let the user upload a résumé template (e.g. a .docx)
  that guides the OUTPUT DESIGN only — fonts, spacing, section order, layout —
  while Kairos supplies the CONTENT from the KB. Design-from-template, content-
  from-truth. Requires a template parser + a style-mapping layer feeding
  `lib/docx-render.ts`'s STYLE.
- **Résumé length policy (seniority-aware).** Target **1 or 2 pages** by default
  (never 3, never a half-empty trailing page), unless the user explicitly requests
  otherwise:
  - **Early career (~<5–10 years):** 1 page is enough. Condense; do not pad to 2.
  - **Experienced / senior (10+ years):** 2 pages recommended; fill both cleanly
    with real content (restore genuine KB achievements rather than adding fluff).
  Derive the target from total years of experience in the profile/KB. The health
  check should score length against this seniority-aware target (not a fixed
  rule), and the generator should choose how many bullets per role to surface to
  hit the target page count with real material.
- **Page-fit is render-verified (v0 done; v2 default).** `lib/docx-render.ts` is
  calibrated (10.5pt base, tuned spacing, `keepNext`/`keepLines`) and verified by
  rendering the actual `.docx` (LibreOffice headless → page PNGs, see
  `scripts/render-resume.sh`) rather than estimating. v2 should auto-fit: render,
  measure page count/fill, and adjust spacing or bullet count to hit the
  seniority-aware target automatically.
- **Pipeline board filters (v2).** The dashboard board is fixed four columns
  (Draft / Applied / Ongoing / Closed) with a per-card status badge
  (Captured/Scored/Drafted/Applied/Interviewing/Offer/Rejected/Withdrawn,
  color-coded). Add filtering/sorting on top: by status, score band, company,
  staleness, and date — so a large pipeline stays navigable. Board grouping lives
  in `lib/pipeline.ts` (`STAGES`); status badge meta in `components/PipelineBoard.tsx`.
