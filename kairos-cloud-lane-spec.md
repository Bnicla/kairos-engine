# Kairos — Cloud Lane Specification

**Status:** Authoritative for the cloud (hosted, multi-tenant) build.
**Date:** 2026-07-07 · **Amended 2026-08-27 (§15.2 — read it first: Phase 0 is done, several sections are superseded by shipped engine work, and the critical path moved to onboarding/enrichment).**
**Relationship to the other spec:** `kairos-spec-v2.md` is the **local lane**
(Claude Code drives it, Max-billed, local `~/Kairos/` files — what's shipped as
v0/v1). This doc is the **cloud lane** it always referred to as the "student lane
/ v2" (see that doc §11 park-list, §12 build order, §15 v2 lane). Same product,
same engine, same invariants — a different **driver** and a different **store**.

**Naming, settled:** stop saying "v1/v2" for architectures (it's overloaded).
Two **lanes** run over one engine:
- **Local lane** — Claude Code + MCP + `LocalStore`. Personal use, flat-rate. Shipped.
- **Cloud lane** — hosted web app + server-side agent + `DriveStore`. This doc.

---

## 1. What the cloud lane is

A hosted, multi-tenant Kairos. A user signs in with Google, connects their Drive,
pastes their own Anthropic API key, and gets the whole Kairos loop (onboard →
score → improve → generate → cover letter / questions → track) in the browser,
with no Claude Code and no local install. Built for **students and other users**
who can't run the local lane.

**Product decisions locked (2026-07-07):**
- **DEC-1 — Billing: bring-your-own key.** Each user supplies their own Anthropic
  API key; we encrypt it at rest and call the API as them. Zero API cost/liability
  to us. (Pooled-key-with-metering is a possible later addition; not built now.)
- **DEC-2 — Driver: server-side agentic chat loop.** An in-browser chat backed by
  a server-side Anthropic tool-use loop that calls the *same tool contracts* the
  MCP server exposes. Cloud users drive the discuss/clarify/enrich loop by chatting,
  exactly as local users drive Claude Code.
- **DEC-3 — Storage: the user's Google Drive.** Personal data lives in the user's
  Drive under an app-scoped `Kairos/` folder (`drive.file` scope). We reactivate
  the parked `DriveStore`.
- **DEC-4 — Hosting: TBD, recommendation persistent container.** See §12. Not yet
  chosen; the spec is written to keep the choice open, with a recommendation.
- **DEC-6 — Monorepo: one engine, two apps.** The two lanes are two apps over a
  single shared engine package (§3.1), never two forks. The engine (prompts, KB
  strip, tool-core, health, renderers) exists **once** — forking it would fork the
  N1/N5 invariants, the one thing we can't allow. npm workspaces; one git history.
- **DEC-5 — Zero server-side user data (stateless backend).** We keep **nothing**
  user-specific in any datastore we run. Personal content → user's Drive (DEC-3);
  session + Google tokens → encrypted JWT cookie in the browser (Auth.js JWT
  strategy, no DB); the Anthropic key → encrypted in the user's Drive
  (`Kairos/.secrets/anthropic.enc`), read per request and decrypted in memory
  only. At rest our server holds only **our own** secrets (Google OAuth client
  secret, `AUTH_SECRET`, `KAIROS_ENCRYPTION_KEY`). **Supabase is dropped from the
  MVP.** Trade-off accepted: no server state means no our-side per-user rate
  limiting — fine under BYO-key (abuse hits the user's own key/bill). A future
  pooled-billing tier would reintroduce state; explicitly out of scope.

## 2. Invariants (inherited, one restated)

N1 (no fabrication), N2 (honest banded scoring), N3 (facts confirmed `[C]`, never
silent), N5 (house style on all generated text) carry over **unchanged** — they
live in the shared engine (`lib/prompts/*`, `lib/kb/stripUnverified`), so both
lanes enforce them by the same code. N4 is restated for a hosted world:

- **N4-cloud — The user owns their data; we keep none of it (DEC-5).** All personal
  content (KB, applications, résumés, letters, answers) *and* the user's Anthropic
  key are written to the *user's* Google Drive via `drive.file` scope — our
  credentials can only ever see files this app created, never the rest of their
  Drive. The session and Google tokens live in an encrypted JWT cookie in the
  user's browser. We run **no user datastore at all**: nothing user-specific
  persists on our side, only our own app secrets. Deleting the Drive folder deletes
  everything. This is stronger than the local lane's N4 and is a core promise, not
  an implementation detail.

## 3. The refactor thesis — two swappable seams, one engine

The local lane already separated *deterministic backend* from *reasoning*. That
separation is exactly what makes the cloud lane cheap: swap two seams, keep the
engine.

```
                         LOCAL LANE                     CLOUD LANE
  DRIVER (reasoning)   Claude Code (Max)      →   server-side Anthropic agent loop
                       + /kairos skill              (user's API key, same tools)
  STORE (persistence)  LocalStore (~/Kairos)  →   DriveStore (user's Drive)
  ─────────────────────────────────────────────────────────────────────────────
  ENGINE (unchanged)   lib/prompts/*  ·  lib/kb/* (stripUnverified)  ·
                       lib/applications · lib/health · lib/qabank ·
                       lib/dashboard · lib/pipeline · lib/resume-render ·
                       lib/docx-render · lib/ingest · lib/types
  TOOL CONTRACTS       the ~26 tools (score/generate/enrich/save/…) —
  (unchanged)          same names & shapes, two thin adapters (§9)
```

Both seams already have **parked implementations** (Drive adapter; auth/crypto/
config/claude caller). The only genuinely new build is the agent loop (§8) and the
tool-core extraction that lets both lanes share the tool logic (§9).

## 3.1 Repo structure (monorepo — DEC-6)

One repo, npm workspaces, one git history. The engine is shared; each lane is an
app that owns its **Store implementation** and its **driver**, and depends on the
engine. The engine has **no** filesystem, Drive, MCP, or Next.js dependency — only
the `Store` *interface* and pure logic.

```
kairos/
  package.json                      workspaces: ["packages/*", "apps/*"]
  packages/
    engine/            @kairos/engine — the shared product, ONE copy
      prompts/*        scoring · generation · extraction · cover-letter · enrichment · insights · voice
      kb/*             experience.ts (stripUnverified), loaders, index-map
      tools/*          the tool-core (§9) — (store, args) => result, shared by both drivers
      store/types.ts   the Store INTERFACE only (no implementation)
      applications.ts · health.ts · qabank.ts · pipeline.ts · dashboard.ts
      resume-render.ts · docx-render.ts · ingest.ts · fetch-job.ts · format.ts · types.ts
  apps/
    local/             @kairos/local — the shipped personal lane
      store/local-fs.ts        LocalStore (implements @kairos/engine Store)
      mcp/server.ts            thin MCP adapter over the tool-core + LocalStore
      web/                     the local dashboard (Next.js: app/, components/)
      skills/kairos/SKILL.md   the Claude Code skill (shares the skill body string, §8)
      scripts/render-resume.sh
    cloud/             @kairos/cloud — the hosted lane (built in Phases 1–5)
      store/drive.ts           DriveStore (implements @kairos/engine Store)
      lib/agent/*              the server-side agent loop + tool-use adapter
      lib/{auth,session,crypto}.ts
      app/                     the web app (Next.js: dashboard, workspace-chat, settings, onboarding)
```

**Key inversion:** stores are constructed by the **app**, not the engine. Engine
functions always take `store` as a parameter (no global `getStore()` inside the
engine). Each app builds its Store (LocalStore, or a per-request DriveStore) and
passes it in. This is what lets one engine serve both lanes unchanged.

**Tooling:** npm workspaces (already on npm — no new package manager). Engine
imported as `@kairos/engine`; replace the current `@/lib/*` and `./lib/*` imports
during the Phase 0 move.

## 4. Architecture

```
Browser (Next.js UI: dashboard, workspace-chat, settings, onboarding)
   │  HTTPS, SSE stream
   ▼
Next.js server (hosted)
   ├─ Auth.js v5 (Google OAuth, JWT strategy — NO DB)          [reactivate auth.ts]
   │     session + Google tokens live in the encrypted browser cookie
   ├─ per-request context (in-memory only): { user, driveAccessToken, anthropicKey }
   │     anthropicKey read from user's Drive (.secrets/anthropic.enc), decrypted
   ├─ AGENT LOOP  ── Anthropic Messages API (tool use) ─────────────────┐
   │     system prompt = kairos skill instructions                      │
   │     tools = TOOL CORE (§9) bound to this user's DriveStore          │
   │     streams text + tool activity to the browser                    │
   ├─ TOOL CORE (lib/tools/*) ── reads/writes ──► DriveStore ──► User's Google Drive
   │     (score, generate, enrich, capture, save_*, render, health, …)  │   (incl.
   ├─ non-agentic server actions (status change, mark submitted, download)  the key)
   └─ NO user datastore (DEC-5) — server holds only its own app secrets ▼
                                                          Anthropic API (user's key)
```

## 5. Multi-tenancy & per-request context

Every request resolves a **per-user context** in memory before touching the
engine, and persists none of it:
- `getSessionContext()` (parked `session.ts`) → `{ email (userKey), driveAccessToken }`
  from the Auth.js JWT session cookie; refreshes the Google token when stale
  (`refreshGoogleAccessToken` in the parked `auth.ts`). No DB read.
- `new DriveStore(driveAccessToken)` → a `Store` scoped to this user's Drive.
- `getAnthropicKey(store)` → read `Kairos/.secrets/anthropic.enc` from the user's
  Drive, decrypt with `crypto.ts` in memory. (Reuse `config.ts`'s
  encrypt/decrypt; drop its Supabase persistence.)

The engine and tool core are **stateless w.r.t. the user** — they receive a
`Store` and (for reasoning) an API key, and nothing is retained after the request
(DEC-5). This is why the same `lib/tools/*` functions serve every tenant without
change, with no user datastore.

## 6. Storage — Google Drive

Reactivate `archive/lib-parked/drive-fs.ts` (`DriveStore`) + `drive.ts`
(primitives: `driveClient`, `ensureFolder`, `initKairosTree`). It already mirrors
the `Store` interface (`listFiles/listFolders/readFile/readBinary/writeFile/
writeBinary/readJson/writeJson`) against the `Kairos/` tree with `drive.file`
scope. Work needed:
- **Verify parity** with the *current* `Store` interface (the interface evolved
  during the local build — reconcile method signatures, binary support, path
  segments).
- **Path→fileId resolution + cache.** Drive addresses by ID, not path. Cache
  folder/file IDs per request (and ideally per session) to cut Drive round-trips;
  the dashboard reads many small files.
- **Performance.** Drive is slower and rate-limited. Batch where possible; cache
  the `_index.json` and `profile.md` reads. Consider a short-lived in-memory cache
  keyed by userKey. (Do **not** mirror content into Supabase — N4-cloud.)
- **`initKairosTree` on first connect** creates the folder structure (§5 of the
  local spec — same layout).

## 7. Auth & secrets

Per DEC-5, **no Supabase, no user datastore.** Everything below is either
client-held (cookie) or user-held (Drive).
- **Auth.js v5 + Google** (parked `auth.ts`): scopes `openid`, email, profile,
  `drive.file`. **JWT strategy** — the session, plus the Google access + refresh
  tokens, live in the encrypted httpOnly cookie in the user's browser. No DB.
- **BYO Anthropic key** (DEC-1): a **Settings** page (parked `Settings.tsx`) where
  the user pastes their key. Encrypt with `crypto.ts` (AES-256-GCM,
  `KAIROS_ENCRYPTION_KEY`) and write the ciphertext to the user's Drive at
  `Kairos/.secrets/anthropic.enc` (via `DriveStore`); store a masked display form
  alongside for the UI. Read + decrypt in memory per request; never log or return
  plaintext. (Reuse `config.ts`'s encrypt/decrypt helpers; discard its Supabase
  read/write.) *Alternative if desired:* keep the encrypted key in the JWT cookie
  instead — cleaner deploy but watch the ~4KB cookie budget shared with the Google
  tokens.
- **Usage display** (optional): with BYO-key, spend is the user's — point them to
  their Anthropic console, or write a lightweight counter file to their Drive. No
  server counter.
- **Env (ours only):** `AUTH_SECRET`, `AUTH_URL`, `AUTH_GOOGLE_ID/SECRET`,
  `KAIROS_ENCRYPTION_KEY`. (No Supabase env.)

## 8. The agent loop (the cloud driver)

The one substantial new build. Replaces "Claude Code + skill" with a server-side
loop that behaves the same.

- **`lib/agent/loop.ts`** — runs an Anthropic Messages API tool-use loop:
  1. **System prompt** = the `/kairos` skill instructions (reuse SKILL.md content
     near-verbatim: golden rules, workflows A–G). One source of truth for both
     lanes — extract the skill body into a shared string the skill file and the
     agent both consume.
  2. **Tools** = the tool core (§9) wrapped as Anthropic `tools` definitions
     (JSON-schema from the same zod shapes the MCP server uses), bound to this
     request's `DriveStore`.
  3. **Loop:** send messages → on `tool_use`, dispatch to the tool core → append
     `tool_result` → repeat until the model returns a final message. Stream
     assistant text and a compact "used tool X" activity trail to the browser
     over SSE.
  4. **Key:** the user's decrypted Anthropic key; **model:** default from config
     (`claude-sonnet-4-6` is the parked default — reconcile to a current model,
     e.g. Sonnet for cost, Opus for hard scoring/generation; allow per-user
     override in Settings).
- **Conversation persistence:** append turns to `applications/<id>/
  conversation.json` (already in the storage schema) so a returning user resumes
  warm. The **Session Brief** (`load_context`) remains the first tool call, same
  as local.
- **Guarantees in an agentic chat:** the model may hear new facts in chat; the
  system prompt (N3) forbids writing them to the KB without confirmation, and
  `save_experience`/`save_confirmed_fact` validation rejects untagged facts. The
  `stripUnverified` strip still runs inside the evidence builders, so the API
  model never receives a `[?]` fact — N1 holds by the same code as local.

## 9. The tool-core refactor (the linchpin)

Today the ~26 tools' logic lives **inside** `mcp/server.ts` handlers. To let both
the MCP server (local) and the agent loop + web routes (cloud) share it, extract
each handler's body into a plain function:

- **`lib/tools/*.ts`** — `(store: Store, args) => Promise<Result>` for every tool
  (`getScoringEvidence`, `saveScore`, `getGenerationEvidence`, `saveResume`,
  `captureJobAd`, `getEnrichmentQuestions`, `saveConfirmedFact`, `renderDocx`,
  `loadContext`, `listApplications`, …). Pure logic, no transport, no model call.
  The zod input schemas move here too (shared by both adapters).
- **Two thin adapters over the core:**
  - `mcp/server.ts` — registers each core fn as an MCP tool (local lane; unchanged
    behavior, just delegates).
  - `lib/agent/tools.ts` — exposes each core fn as an Anthropic tool-use tool
    (cloud lane), plus a dispatcher that runs `store`-bound calls.
- **Reasoning boundary stays intact:** evidence tools still return
  `{system_prompt, user_message}`. In the **local** lane Claude Code consumes
  them; in the **cloud** lane the agent loop feeds them to the API and routes the
  JSON result back into the matching `save_*` core fn. Same contract, different
  executor. (Note: in the cloud lane the evidence-fetch and the API call can be
  fused into single higher-level tools — e.g. a `score` tool that fetches
  evidence, calls the model, validates, and saves — so the agent takes one step
  instead of three. Keep the split fns underneath for reuse.)

This refactor is the prerequisite for everything cloud and also *cleans up the
local lane* (thinner MCP handlers). Do it first.

## 10. Reasoning: model, cost, validation

- **BYO-key**, so cost is the user's. Still: pick sensible default models (cheap
  by default, escalate for scoring/generation), show usage, and cap runaway loops
  (max tool iterations per turn).
- **JSON validation + retry:** the parked `claude.ts` has `extractJson()` +
  JSON-prefill; combine with zod validation of each result against `lib/types.ts`.
  On invalid JSON, re-ask once (same pattern as R2 in the local spec). This
  matters more in the cloud lane because there's no human catching a bad shape.

## 11. Job-ad fetch (server-side)

The local lane leaned on Claude Code's WebFetch. The cloud lane needs its own:
- **`lib/fetch-job.ts`** — best-effort server fetch + readability/DOM extraction
  to text; strong **paste-text fallback** (many boards are JS-gated or block
  bots). Expose as a `capture_job_ad`-time step; snapshot-first still holds (write
  `snapshot.md` before returning the appId). Optionally give the agent a
  `fetch_job_ad` tool so it can retry/clean. (R1 from the local spec applies.)

## 12. Rendering & deployment

- **DOCX** (`lib/docx-render.ts`) is pure JS — runs anywhere, primary deliverable.
- **PDF** currently uses LibreOffice headless (`scripts/render-resume.sh`) /
  `puppeteer-core`. That needs a real OS process.
- **Recommendation (DEC-4): a persistent Node container** (Fly.io / Railway /
  Render) rather than pure serverless, because it (a) runs LibreOffice headless so
  we reuse the *already-validated* render+page-fit path, (b) handles long,
  streamed agent-loop turns without serverless timeout gymnastics, (c) is a
  simple always-on process, cheap at this scale.
  - **Alternative — Vercel:** fastest Next.js DX, but no LibreOffice → DOCX-only,
    with PDF via an external render service or a small companion container; and
    streamed agent turns must fit function limits. Viable if we accept DOCX-first.
  - **Decision still open** ("not sure yet"). Pick before Phase 4. If undecided,
    default to the container so nothing about rendering or loop-length constrains
    the design.

## 13. Onboarding as the hook (student adoption)

Reactivate `Onboarding.tsx` + `/api/onboard`, wired to the cloud path: upload
résumé PDF → `extract_resume_text` (unpdf, server-side) → agent runs the
extraction prompt → save KB to Drive → **run the résumé health check** (`lib/
health.ts`, already deterministic and shared) → present the report as the
first-run deliverable → route straight into the enrichment interview for
thin/weak roles (local-spec §15 v2 lane). Turns a passive upload into an active
first session.

## 14. Reuse / reactivate / build / drop (grounded in the inventory)

**Reuse as-is (shared engine):** `lib/prompts/*`, `lib/kb/*` (incl.
`stripUnverified` in `experience.ts`), `lib/applications.ts`, `lib/health.ts`,
`lib/qabank.ts`, `lib/dashboard.ts`, `lib/pipeline.ts`, `lib/resume-render.ts`,
`lib/docx-render.ts`, `lib/ingest.ts`, `lib/types.ts`, `lib/store/types.ts`.

**Reactivate from `archive/` (verify against current interfaces first):**
- `archive/lib-parked/drive-fs.ts`, `drive.ts` → `lib/store/drive.ts` (DriveStore).
- `archive/lib-parked/auth.ts`, `session.ts` → auth (JWT strategy) + per-request
  context.
- `archive/lib-parked/crypto.ts` → key encrypt/decrypt (keep). `config.ts` → reuse
  only its encrypt/decrypt helpers; **drop its Supabase persistence.**
  `supabase.ts` → **dropped** (DEC-5, no user datastore).
- `archive/lib-parked/claude.ts` → Anthropic caller (fold into the agent loop /
  reasoning helper; drop the Supabase `recordUsage` call and the `claude-cli`
  provider — dev-only relic).
- `archive/web-app-v1/` components (`ChatPanel`, `Workspace`, `DocumentPanel`,
  `DriveSetup`, `Settings`, `Onboarding`, `Nav`) → templates for the cloud UI,
  rewired to the new API/agent + `DriveStore` (and to the matured dashboard/
  scorecard/health/kb pages the local lane already has).

**Build new:**
- `lib/tools/*` tool core + the two adapters (§9).
- `lib/agent/loop.ts` + `lib/agent/tools.ts` + SSE streaming route (§8).
- `lib/fetch-job.ts` server-side job fetch (§11).
- Shared skill-instruction string (one source for SKILL.md + agent system prompt).
- Cloud API routes / server actions that call the tool core with the per-request
  `DriveStore` (non-agentic mutations: status, mark-submitted, downloads).
- Deployment config for the chosen host (§12).

**Drop:** `providers/claude-cli.ts`; `supabase.ts` and Supabase-backed usage
metering (DEC-5); any pooled-billing scaffolding (not in scope under DEC-1); the
retired local `ChatPanel` assumptions that Claude Code exists.

## 15. Build order (phases)

- **Phase 0 — Monorepo carve-out + tool-core refactor.** Two sub-steps, both
  no-behavior-change, verified against the local loop after each:
  - **0a — Workspaces.** Restructure into `packages/engine` + `apps/local`
    (§3.1): move files, rewrite `@/lib/*`→`@kairos/engine` imports, and **invert
    store injection** (engine takes `store`; the app owns `getStore()`/LocalStore).
    Confirm the MCP server + local dashboard still run.
  - **0b — Tool-core.** Extract `mcp/server.ts` handler bodies into
    `packages/engine/tools/*` with shared zod schemas; MCP server becomes a thin
    adapter. Confirm the local loop (capture→score→generate→render) still works.
  *(Unblocks everything. `apps/cloud` is created fresh in later phases.)*
- **Phase 1 — DriveStore.** Reactivate + reconcile the Drive adapter to the
  current `Store` interface; add path→id caching; `initKairosTree` on connect.
  Test: run the tool core against a real Drive account end to end (capture →
  score-evidence → save) with no UI.
- **Phase 2 — Auth + secrets + context.** Auth.js Google login, Settings page for
  the BYO Anthropic key (encrypt + store + mask), `getSessionContext` +
  per-request `DriveStore`/key wiring.
- **Phase 3 — Agent loop.** `lib/agent/*`, SSE route, shared skill system prompt,
  JSON validation/retry, conversation persistence. Prove the full loop in a bare
  chat page against a test account.
- **Phase 4 — Cloud UI.** Rewire the archived workspace-chat + onboarding + the
  existing dashboard/kb/health/application pages to the cloud data path. Server-
  side job fetch. Pick + configure the host; validate DOCX/PDF rendering there.
- **Phase 5 — Onboarding hook + polish.** First-run extract → health report →
  enrichment; usage display; empty/error states; a small closed beta.

## 15.1 Amendments (2026-07-20, build green-lit for the student lane)

- **DEC-7 — Content-agnostic engine.** The engine must carry NO user-specific
  defaults: no personal template as the implicit design, no personal examples in
  prompts (rules illustrated generically), no hardcoded headlines/framings. A
  user's design and calibration live in THEIR store, never in code.
- **DEC-8 — TemplateSpec + template upload.** `docx-render.ts`'s STYLE becomes an
  injectable `TemplateSpec` (fonts, sizes, margins, colors, spacing), with the
  current clean design as `DEFAULT_TEMPLATE`. Cloud users may upload a .docx
  template; we parse styles.xml/document.xml into a TemplateSpec (DESIGN only —
  content always comes from the KB), stored per-user in Drive `templates/`.
- **DEC-9 — Seniority-aware length, implemented.** Target pages derive from total
  years in the KB (<~8 years → 1 page; senior → 2), overridable per user. Feeds
  the generation prompt and the render page-fit check. Students default to 1 page.
- **Onboarding is the front door, not final polish.** Reordered: Phase 2 (auth)
  → engine groundwork (DEC-7/8/9) → onboarding (§13) → agent loop → full UI/host
  → beta. For a student, first-run value IS the product: upload résumé → KB
  extraction ([R]) → health report → enrichment interview.
- Isolation guarantee: everything lands in `apps/cloud` + additive engine seams;
  the local lane's behavior is unchanged (DEFAULT_TEMPLATE = today's design).

## 15.2 Amendments (2026-08-27) — state of the world, revised critical path

Written after a month of local-lane building and one week of intensive field use
(10 applications, 5 interview processes in ~7 days). Everything below is
grounded in shipped code, not plans.

### A. Where the phases actually stand

- **Phase 0a (monorepo carve-out): DONE.** `packages/engine` + `apps/local` +
  `apps/cloud` exist as npm workspaces; engine takes `store` as a parameter;
  local MCP server and dashboard run over `@kairos/engine`.
- **Phase 0b (tool-core extraction): PARTIAL.** The guarded save paths live in
  `packages/engine/tools/` (`ops.ts` — saveGeneratedResume/saveScoredReport with
  grounding + house-style gates; `checks.ts`; `schemas.ts`), and evidence
  assembly/capture logic lives in engine modules. But `apps/local/mcp/server.ts`
  still carries substantial handler bodies. **Remaining Phase-0 work:** finish
  extracting handler bodies to `packages/engine/tools/*` so the cloud agent loop
  can bind them (§9). This is the first cloud task, unchanged in spirit.
- **Phase 2 (auth/secrets/context): PARTIALLY REACTIVATED.** `apps/cloud` already
  has `lib/session.ts` (getSessionContext), `getAnthropicKey`, `resolveModel`,
  and a working `/api/source` route built against them. Not yet wired to a real
  OAuth flow end to end.

### B. Engine capabilities shipped since 2026-07-20 (all cloud-inheritable)

The cloud lane gets these for free; earlier sections that assumed their absence
are amended:

1. **Sourcing subsystem** (`packages/engine/sourcing/*`): 6,000+ board registry,
   mechanical prefilter (function/location/recency gates), LLM triage with
   loud `triage_error` surfacing, per-user `search-profile.json`, dropped-roles
   rescue. The cloud `/api/source` route already drives it.
2. **ATS JSON adapters in `fetchJobAd`** (Ashby by job-ID, Workday CXS,
   Greenhouse boards-api fallback): **§11 is largely SOLVED** — server-side
   capture now works on JS-rendered ATS pages with the paste-text fallback as
   last resort, exactly as §11 hoped. Phenom-hosted sites
   additionally work via JSON-LD extraction from raw HTML (pattern proven, not
   yet folded into `fetchJobAd`).
3. **Visual layout probe + auto-converging generation** (`layout-probe.ts` +
   headless retry loops in `apps/local/lib/generate.ts`): LibreOffice renders
   the docx, measures real page count/fill, and generation retries with
   findings fed back — the "fused tool" pattern §9 anticipated, already proven
   headless. **§10's "no human catching a bad shape" risk is substantially
   mitigated by shipped code** (zod + grounding gate + style gate + word floor +
   layout probe + bounded retries).
4. **PDF pipeline:** every docx renders a faithful sibling PDF via LibreOffice
   (headless `svp` backend). **§12's decision is effectively forced: persistent
   container.** LibreOffice is now load-bearing twice (probe + deliverable);
   serverless-without-it would regress shipped quality. Treat DEC-4 as resolved
   to container unless something changes.
5. **Dream-company watcher** (`apps/cloud/scripts/dream-watch.mts`): direct
   career-API monitoring (Google HTML-embed parsing, Greenhouse/Ashby/Lever
   APIs) for user-designated priority companies, diffed daily. Cloud-ready as a
   central job.
6. **Autofill Chrome extension** (`apps/autofill-extension/`): fills any ATS
   form via an LLM field-mapper endpoint (`/api/autofill-map` maps scraped
   fields → profile values), attaches the tailored PDF, never auto-submits.
   **New product surface not in the original spec** — see DEC-11.
7. **Quality machinery hardened:** reference-resume register, context-aware
   style gates, `page_break_before` layout control, seniority word floors,
   provenance audit on every generated document.
8. **Dev infra:** MCP hot-reload supervisor (`mcp/dev-proxy.ts`) — local-lane
   DX, no cloud impact.

### C. New decisions

- **DEC-10 — Sourcing runs centrally, once.** The sweep (~130k postings/run) and
  the dream-watcher execute as OUR scheduled jobs producing a shared corpus;
  per-user profiles filter and triage it. Per-user sweeps would be absurd
  (cost, load on boards). Note the tension with DEC-5: the shared corpus is
  **not user data** (public postings), so a server-side corpus store is
  permitted; per-user profiles/seen-lists still live in the user's Drive.
  Per-user triage calls bill to the user's key (DEC-1).
- **DEC-11 — Extension as an authenticated cloud surface, demographics stay in
  Drive.** The extension re-points from localhost to the cloud API with the
  user's session. The field-mapper is a metered per-call model use (user's
  key). **EEO/demographic answers and addresses are the most sensitive data in
  the system: they live ONLY in the user's Drive (`autofill.json` equivalent),
  are sent to the mapper in-memory per request, and are never persisted
  server-side** (N4-cloud applies with extra force). Chrome Web Store review
  lead time is a real dependency — start early, like R-cloud-2.
- **DEC-12 — Onboarding/enrichment is THE critical path, formally.** §15.1
  already reordered toward onboarding; field experience upgrades this to the
  central bet: generation quality is a direct function of KB richness, and the
  local lane's KB came from weeks of guided enrichment conversation. The
  student MVP lives or dies on the enrichment interview agent (upload → [R]
  extraction → health report → conversational enrichment writing [C] facts).
  Budget it as the largest single UI/agent build, not a polish phase.

### D. What one week of field use taught (design inputs, not vibes)

- **The mechanical gates carry more of the quality than expected.** Grounding
  audit + style gates + layout probe + retry produced 9 submission-grade
  documents in a day with no human edits. The agent loop needs judgment mainly
  for *fit assessment and strategy* (e.g. detecting a security-clearance
  deal-breaker inside an attractive title, or downgrading a strong-sounding JD),
  which lives in the scoring prompt's honesty rules — already shared engine code.
- **Interview conversion evidence:** tailored agentic-AI applications converted
  to recruiter screens at ~50% within days. This is the marketing page and the
  pitch; keep telemetry hooks in mind (opt-in, Drive-stored counters only).
- **ATS adapters are a maintenance treadmill** (three breakages observed in one
  week: Phenom false "job filled" fallbacks, dead Google v3 API, AFD TLS
  blocking Microsoft). Add **R-cloud-7**: budget ongoing adapter maintenance;
  design every fetch path to fail loudly into paste-fallback, never silently.
- **Title-expansion profiles matter:** the function gate is per-user config
  (`search-profile.json`), and users will want to tune it conversationally
  (ours moved from "product" to a 12-term whitelist through dialogue). The
  enrichment agent should also own search-profile refinement.

### E. Revised remaining build order (supersedes §15 sequencing, keeps its content)

1. **Finish Phase 0b** — complete tool-core extraction from `mcp/server.ts`.
2. **DriveStore parity** (Phase 1 as written) + path→id caching.
3. **Auth end-to-end** (finish Phase 2 from its partial state) + Settings/key.
4. **Onboarding + enrichment interview agent** (DEC-12; the big build).
5. **Agent loop + workspace chat** (Phase 3 as written; fuse score/generate into
   single tools per §9's note — the local headless loops are the template).
6. **Central sourcing + dream-watch jobs** (DEC-10) + cloud UI (Phase 4).
7. **Container deploy with LibreOffice** (DEC-4 resolved) · **closed MIT beta**
   (PM CoP cohort is the natural pilot group).
8. **Extension cloud-ification** (DEC-11) — after beta, not before.

Honest sizing from the current state: **~6–10 focused weeks to a usable student
beta** (steps 1–7), with step 4 the widest error bar.

## 16. Risks

- **R-cloud-1 — Drive latency/limits.** Many small reads per dashboard load.
  Mitigate with id caching + batched reads; keep the `_index.json` fast-path.
- **R-cloud-2 — Google OAuth verification.** `drive.file` still requires the app
  to be published/verified for outside users (the parked task #5). Plan the
  consent-screen/verification lead time before any real beta.
- **R-cloud-3 — Agent-loop cost & runaways.** BYO-key protects *us*, not the user.
  Cap tool iterations, default to cheaper models, show live usage.
- **R-cloud-4 — Reasoning-shape drift.** No human to catch a malformed score/
  résumé. Enforce zod validation + one retry in the loop; fail loud in the UI.
- **R-cloud-5 — Rendering host.** PDF needs LibreOffice/Chrome. Settle §12 before
  Phase 4 or the render path constrains the deploy.
- **R-cloud-6 — Skill/agent prompt drift.** The skill body now feeds two drivers.
  Keep it in ONE shared string; never edit SKILL.md and the agent prompt
  separately.
- **R-cloud-7 — ATS adapter drift (added 2026-08-27).** External job-site
  surfaces break continuously (observed in one week: Phenom serving false
  "position filled" fallbacks to non-JS fetchers, Google's careers JSON API
  removed, Azure Front Door TLS-blocking Microsoft's API). Every fetch path must
  fail LOUDLY into the paste-text fallback; budget recurring adapter upkeep as
  operations, not one-time build.
- **R-cloud-8 — Sensitive-data surface of autofill (added 2026-08-27).**
  EEO/demographic answers, addresses, and work-authorization data flow through
  the extension and mapper. DEC-11's Drive-only rule is a hard line; any
  server-side logging of mapper payloads would violate N4-cloud. Review before
  every change to that path.
