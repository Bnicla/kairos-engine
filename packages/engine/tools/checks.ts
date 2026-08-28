import type { Experience } from "@kairos/engine/kb/types";
import { serializeExperience, stripUnverified } from "@kairos/engine/kb/experience";
import { BANNED_WORDS } from "@kairos/engine/prompts/voice";
import type { GeneratedResume } from "@kairos/engine/types";

/**
 * Deterministic quality gates for generated résumés. These run at SAVE time in
 * lib/tools/ops.ts — after the model (or a human) authors the artifact — so the
 * three product promises hold no matter which driver produced it:
 *   1. grounding — every employer and metric traces to verified KB evidence
 *   2. style    — the house-style rules (N5) are machine-checked, not vibes
 *   3. ATS      — the résumé demonstrably carries the job ad's own language
 */

// --- Style ------------------------------------------------------------------

export interface StyleViolation {
  rule: "em-dash" | "not-just-but" | "banned-word" | "empty-adverb" | "verb-clustering" | "leadin-not-title";
  detail: string;
}

const NOT_JUST = /\b(?:not\s+(?:just|only|merely)|isn't\s+just|it's\s+not\s+about)\b[^.\n]{0,80}\bbut\b/i;
const EMPTY_ADVERBS = /\b(extremely|incredibly|deeply|truly)\b/gi;

/** Hard style violations (em dashes, banned words, "not just X but Y") + soft ones (adverbs). */
export function checkStyle(text: string): StyleViolation[] {
  const out: StyleViolation[] = [];
  const emDashes = (text.match(/—/g) ?? []).length;
  if (emDashes > 0) out.push({ rule: "em-dash", detail: `${emDashes} em dash(es) present` });
  if (NOT_JUST.test(text)) out.push({ rule: "not-just-but", detail: `matches "not just X but Y" pattern` });
  for (const w of BANNED_WORDS) {
    const re = new RegExp(w.includes(" ") ? escapeRe(w) : `\\b${escapeRe(w)}\\w*`, "i");
    const m = text.match(re);
    if (m) out.push({ rule: "banned-word", detail: `"${m[0]}"` });
  }
  // "orchestration/orchestrate" is real AI terminology (agent orchestration,
  // model orchestration) but a worn-out power-verb in general use. Allow it only
  // when an AI/agent/system term sits nearby; flag it otherwise (owner directive).
  const ORCH_CONTEXT = /\b(agent|agents|model|models|llm|llms|ai|ml|workflow|workflows|pipeline|pipelines|service|services|microservice|task|tasks|container|kubernetes|prompt|prompts|tool|tools|system|systems|data)\b/i;
  for (const m of text.matchAll(/\borchestrat\w*/gi)) {
    const i = m.index ?? 0;
    const ctx = text.slice(Math.max(0, i - 60), i + m[0].length + 60);
    if (!ORCH_CONTEXT.test(ctx)) out.push({ rule: "banned-word", detail: `"${m[0]}" (generic power-verb; fine only in AI/agent context)` });
  }
  const adv = text.match(EMPTY_ADVERBS);
  if (adv) out.push({ rule: "empty-adverb", detail: [...new Set(adv.map((a) => a.toLowerCase()))].join(", ") });

  // Soft: the same opening verb on 4+ bullets reads as machine cadence, even
  // when the verb itself isn't banned (the "Drove/Drove/Drove" failure mode).
  const openers = [...text.matchAll(/^-\s+(?:\*\*[^*]+\*\*:?\s*)?(\w+)/gim)].map((m) => m[1].toLowerCase());
  const counts = new Map<string, number>();
  for (const o of openers) counts.set(o, (counts.get(o) ?? 0) + 1);
  const clustered = [...counts.entries()].filter(([, n]) => n >= 4);
  if (clustered.length) {
    out.push({
      rule: "verb-clustering",
      detail: clustered.map(([w, n]) => `"${w}" opens ${n} bullets`).join("; "),
    });
  }

  // HARD: a bold bullet lead-in must be a condensed noun-phrase TITLE
  // (≤4 words, label-like), never a claim, slogan, or sentence. Catches
  // "**Owned outcomes, not requirements:**" and
  // "**Intelligent automation that removes manual effort:**" (user feedback, 2026-07-28).
  // Parenthetical qualifiers like "(0-to-1, shipped)" are allowed and ignored.
  // Only bullet lead-ins are titles: bold at the start of a bullet AND
  // followed by a colon. Bold without a colon (education credentials, inline
  // emphasis) is exempt.
  for (const m of text.matchAll(/^[-*]\s+\*\*([^*]+?)(?::\*\*|\*\*:)/gm)) {
    const leadin = m[1].trim();
    const core = leadin.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    // Connectors (&, +, /) don't count: "Global Expansion & Roadmap Execution" is 4 words.
    const words = core.split(/\s+/).filter((w) => /\w/.test(w));
    const problems: string[] = [];
    if (words.length > 5) problems.push(`${words.length} words (max 5)`);
    if (core.includes(",")) problems.push("contains a comma (reads as a claim, not a title)");
    if (/\b(that|which|who)\b/i.test(core)) problems.push("contains a relative clause");
    if (problems.length) {
      out.push({ rule: "leadin-not-title", detail: `"${leadin}": ${problems.join("; ")}` });
    }
  }
  return out;
}

export const isHardStyleViolation = (v: StyleViolation) =>
  v.rule !== "empty-adverb" && v.rule !== "verb-clustering";

// --- ATS coverage -----------------------------------------------------------

export interface AtsCoverage {
  /** matched/total over the extracted JD terms, 0..1 */
  coverage: number;
  matched: string[];
  missing: string[];
}

const STOPWORDS = new Set(
  ("the a an and or of to in for with on at by from as is are was were be been will would can could should our your their its this that these those you we they it what who whom whose which where when how why not no nor if then than into over under more most other others such own same so too very just also both each any all some few per via must may might do does did done has have had having across within without between about against during before after above below up down out off again further once here there ok").split(" "),
);

/**
 * Extract the job ad's salient vocabulary (acronyms, frequent terms, frequent
 * bigrams) and report how much of it the résumé actually carries. Heuristic and
 * advisory — a recruiter-read complement, not a guarantee — but it catches the
 * failure mode of a tailored résumé that never says the ad's own words.
 */
export function checkAtsCoverage(jobText: string, resumeText: string): AtsCoverage {
  const resume = normalize(resumeText);

  // Acronyms / capitalized tech terms straight from the ad (AI, ML, PMO, GDPR…).
  // Pure A–Z only (no "MA/", "AI-" fragments), minus corporate boilerplate that
  // says nothing about fit.
  const ACRONYM_NOISE = new Set(["nyse", "hq", "usa", "eeo", "llc", "inc", "us", "uk", "eu", "ma", "ny", "tx", "ca", "co", "nh", "ut"]);
  const acronyms = [...new Set(jobText.match(/\b[A-Z][A-Z0-9&+]{1,9}\b/g) ?? [])]
    .filter((a) => a.length >= 2 && !/^\d+$/.test(a) && /^[A-Z]/.test(a))
    .map((a) => a.toLowerCase())
    .filter((a) => !ACRONYM_NOISE.has(a));

  const words = normalize(jobText)
    .split(/[^a-z0-9'+-]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const unigrams = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w);

  const bigrams = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const b = `${words[i]} ${words[i + 1]}`;
    bigrams.set(b, (bigrams.get(b) ?? 0) + 1);
  }
  const topBigrams = [...bigrams.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([b]) => b).slice(0, 10);

  const terms = [...new Set([...acronyms, ...topBigrams, ...unigrams])].slice(0, 30);
  // Stem-blind matching ("translate strategy" must match "translates strategy"):
  // compare with word-final s/es stripped on both sides. Advisory, so the slight
  // looseness is acceptable.
  const stem = (s: string) => s.replace(/(\w)(?:es|s)\b/g, "$1");
  const resumeStemmed = stem(resume);
  const hit = (t: string) => resume.includes(t) || resumeStemmed.includes(stem(t));
  const matched = terms.filter(hit);
  const missing = terms.filter((t) => !hit(t));
  return { coverage: terms.length ? matched.length / terms.length : 1, matched, missing };
}

// --- Grounding (anti-fabrication, mechanical) --------------------------------

export interface GroundingIssue {
  kind: "unknown_employer" | "ungrounded_metric" | "unknown_source";
  detail: string;
}

/**
 * Mechanically verify a generated résumé against the verified KB evidence:
 *  - every experience employer must be a KB experience company
 *  - every metric token in bullets/summaries must appear in the stripped
 *    ([?]-free) KB corpus — a metric the KB doesn't contain cannot ship
 *  - every provenance_audit.source_experience must name a real KB file
 * `extraCorpus` admits curated non-experience sources (profile, education).
 */
export function checkResumeGrounding(
  gen: GeneratedResume,
  experiences: Experience[],
  extraCorpus = "",
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const companies = new Set(experiences.map((e) => e.frontmatter.company.toLowerCase().trim()));
  const fileNames = new Set(experiences.map((e) => e.fileName.replace(/\.md$/, "")));
  const corpus = normalizeMetrics(
    experiences.map((e) => serializeExperience(stripUnverified(e))).join("\n") + "\n" + extraCorpus,
  );

  for (const exp of gen.resume.experience) {
    if (!companies.has(exp.company.toLowerCase().trim())) {
      issues.push({ kind: "unknown_employer", detail: `"${exp.company}" is not a knowledge-base experience` });
    }
  }

  const prose = [
    gen.resume.executive_summary,
    ...gen.resume.experience.flatMap((e) => [e.summary ?? "", ...e.bullets]),
  ].join("\n");
  for (const token of extractMetricTokens(prose)) {
    if (!corpus.includes(token.normalized)) {
      issues.push({ kind: "ungrounded_metric", detail: `"${token.raw}" not found in any verified KB fact` });
    }
  }

  // A source is grounded if it names a real KB experience by ANY of its
  // identifiers — file name, frontmatter id, or company. The guarantee is
  // "traces to a real experience", not "spelled one particular way".
  const ids = new Set(
    experiences.map((e) => (e.frontmatter.id ?? "").toLowerCase().trim()).filter(Boolean),
  );
  for (const entry of gen.provenance_audit) {
    const ref = entry.source_experience.replace(/\.md$/, "").trim();
    const known =
      fileNames.has(ref) ||
      ids.has(ref.toLowerCase()) ||
      companies.has(ref.toLowerCase()) ||
      ["profile", "education"].includes(ref.toLowerCase());
    if (!known) {
      issues.push({
        kind: "unknown_source",
        detail: `provenance source "${entry.source_experience}" is not a KB experience (use a file name, id, or company from the KB)`,
      });
    }
  }
  return issues;
}

interface MetricToken {
  raw: string;
  normalized: string;
}

/**
 * Pull the tokens that would constitute fabrication if invented: money, percents,
 * "40+"-style scale counts, M/B/k-suffixed magnitudes, and large exact numbers.
 * Years (1900–2099), date ranges, and "N+ years" tenure math are excluded —
 * they're derivable, not claims.
 */
export function extractMetricTokens(text: string): MetricToken[] {
  const out: MetricToken[] = [];
  const re = /(?:[$€£]\s?\d[\d.,]*\s?[MBKmbk]?\+?)|(?:\d[\d.,]*\s?%)|(?:\b\d[\d,]*\+)|(?:\b\d{1,3}(?:,\d{3})+\b)|(?:\b\d+(?:\.\d+)?\s?[MBK]\b\+?)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const after = text.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 12);
    if (/^\s*(years?|yrs?)\b/i.test(after)) continue; // tenure math, not a claim
    const bare = raw.replace(/[^0-9]/g, "");
    if (bare.length === 4 && +bare >= 1900 && +bare <= 2099) continue; // year
    out.push({ raw, normalized: normalizeMetrics(raw) });
  }
  return out;
}

// --- helpers ----------------------------------------------------------------

const normalize = (s: string) => s.toLowerCase().replace(/[’']/g, "'");
/** Comparison form for metric matching: lowercase, no commas/spaces. */
const normalizeMetrics = (s: string) => s.toLowerCase().replace(/[,\s]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
