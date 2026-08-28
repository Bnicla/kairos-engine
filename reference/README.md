# Reference

Live material the v2 build depends on. Unlike `../archive/`, these are **active
references** — the prompts we reuse verbatim and the worked examples we validate
against.

- `ats-scoring-engine-v1.md` — the scoring system prompt (used verbatim; becomes
  the `/kairos` skill's scoring guidance)
- `generation-engine-v1.md` — the generation system prompt (verbatim; skill's
  generation guidance)
- `kb-schema-v1.md` — the knowledge-base file schema (experience frontmatter +
  provenance-tagged body)
- `example-experience-amazon.md` — a fully-formed example experience file
- `scoring-worked-example.md` — a hand-worked scoring example (Twilio)
- `scoring-test-toast.md` — scoring test case (Toast KDS)
- `job-snapshot-toast-kds.md` — an example captured job-ad snapshot

Use these to keep the skill's reasoning consistent and to validate v0 output
against known-good results.
