# Kairos — an agentic career-operations system built on Claude

Kairos is the system I built to run my own executive job search the way I believe AI products should be built: agents doing the mechanical work, hard quality gates doing the judging, and a human owning every decision that matters. It has been my daily driver for two months; in its most recent week of operation it produced ten tailored applications and five active interview processes.

**This repo is shared as a work sample.** It is a live personal project, not a packaged product: expect sharp edges, and see the license note below.

## What it does

One pipeline, end to end:

- **Sourcing** — a nightly sweep scans 6,000+ job boards through their ATS APIs (~130k postings/run), applies mechanical gates (function, seniority, location, freshness), then LLM-triages survivors into honest fit bands. A separate watcher monitors target companies' career APIs directly and reports only what is new.
- **Capture** — paste any job URL; per-ATS JSON adapters (Ashby, Workday, Greenhouse) handle JS-rendered pages, with a loud paste-text fallback. Silent degradation is treated as a bug.
- **Scoring** — three separated axes: parse-safety (deterministic), match (banded, never falsely precise), authenticity. The scorer is required to recommend *against* applying when fit is weak, and does.
- **Generation** — résumés generate from a knowledge base where every fact carries provenance (`[R]` verified / `[C]` confirmed / `[?]` unverified). Unverified facts are stripped **in code** before the model sees evidence, so fabrication is structurally impossible. Output passes hard gates: a mechanical grounding audit (every metric must exist verbatim in the KB), anti-AI-tell style rules, seniority-aware length floors, and a visual layout probe that renders with LibreOffice, measures real page fill, and auto-retries until layout converges. Every document ships as docx + faithful PDF.
- **Application** — a Chrome extension scrapes any ATS form, asks Claude to map fields to the profile server-side, attaches the tailored PDF, and **never submits** — review stays human.

## Architecture

TypeScript monorepo (npm workspaces):

```
packages/engine     the shared product: prompts, KB + provenance stripping, gates,
                    renderers (docx/pdf), sourcing, tool-core — storage-abstracted
apps/local          personal lane: Next.js dashboard + MCP server (~25 tools)
                    driven by Claude Code; hot-reload dev proxy for the MCP server
apps/cloud          hosted lane (in progress): Google sign-in, user's own Drive as
                    storage, bring-your-own Anthropic key — see kairos-cloud-lane-spec.md
apps/autofill-extension  Chrome MV3 extension with LLM field mapping
```

Reasoning runs through Claude (Claude Code + MCP locally; a server-side agent loop in the cloud design). Deterministic work — gates, rendering, diffing, scheduling — is plain code. Design docs live in the `kairos-*-spec.md` files and `reference/`.

## Design positions

- **Grounding is enforced in code, not requested in prompts.** The model cannot cite what evidence assembly never gave it.
- **Honest scoring is a feature.** The system has talked its user out of applying — including a role whose attractive title concealed a security-clearance requirement.
- **Evaluation gates over vibes.** Documents ship when they pass measurable checks; retry loops converge on the checks.
- **Fail loudly.** Job-site adapters break weekly; every failure surfaces in the UI rather than silently degrading.
- **Human-in-the-loop where it counts.** Never submits an application, never writes an unconfirmed fact, never sends an email.

## Author & license

Designed and directed by **Boris Nicolas**, built with Claude as a pair — the architecture, gates, provenance model, prompts, and product decisions are mine.

**All rights reserved.** Source is published for reading and evaluation as a work sample; no license is granted for reuse or redistribution.
