import type { RankedPosting } from "./types";

/**
 * Triage step (spec §6): ONE cheap model call over the deterministic
 * survivors, run INSIDE the pipeline so the Sourced column only ever shows a
 * curated shortlist (students must not face 400 raw cards). The engine stays
 * model-agnostic: callers supply the completion; this module builds the prompt
 * and parses/applies the verdicts.
 */

export interface TriageVerdict {
  url: string;
  verdict: "SHORTLIST" | "SKIP";
  guess_band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";
  one_liner?: string;
}

export function buildTriagePrompt(postings: RankedPosting[], candidateSummary: string): string {
  const rows = postings
    .map((p) => `- url: ${p.url}\n  title: ${p.title}\n  company: ${p.company}\n  location: ${p.location || "n/a"}`)
    .join("\n");
  return `You are triaging freshly posted jobs for a candidate. Judge each posting from its title/company/location ONLY (no fetching). SHORTLIST postings whose role plausibly fits the candidate's function, seniority and domains; SKIP clear mismatches (wrong function like marketing/recruiting/engineering-IC, wrong seniority direction, irrelevant domain). guess_band is a rough fit guess: STRONG / COMPETITIVE / DEVELOPING / WEAK — it is a pre-screen guess, not a score. one_liner: max 12 words, why it fits (or the main caveat). Be selective: a student should see a short list worth their time, not everything.

CANDIDATE:
${candidateSummary}

POSTINGS:
${rows}

Reply with ONLY a JSON array, no prose, one object per posting:
[{"url":"...","verdict":"SHORTLIST|SKIP","guess_band":"STRONG|COMPETITIVE|DEVELOPING|WEAK","one_liner":"..."}]`;
}

export function parseTriageResponse(text: string, validUrls: Set<string>): Map<string, TriageVerdict> {
  const out = new Map<string, TriageVerdict>();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr as TriageVerdict[]) {
    if (item && typeof item.url === "string" && validUrls.has(item.url) && (item.verdict === "SHORTLIST" || item.verdict === "SKIP")) {
      out.set(item.url, item);
    }
  }
  return out;
}

const BAND_ORDER: Record<string, number> = { STRONG: 0, COMPETITIVE: 1, DEVELOPING: 2, WEAK: 3 };

/**
 * Keep only SHORTLISTed postings, attach band + one-liner, order by band then
 * the deterministic rank (recency-dominant). Falls back to the deterministic
 * top-N when the verdict map is empty (model unavailable) — the column must
 * never be empty just because triage failed.
 */
export function applyTriage(
  postings: RankedPosting[],
  verdicts: Map<string, TriageVerdict>,
  cap: number,
): { list: RankedPosting[]; triaged: boolean } {
  if (verdicts.size === 0) return { list: postings.slice(0, cap), triaged: false };
  const kept = postings
    .filter((p) => verdicts.get(p.url)?.verdict === "SHORTLIST")
    .map((p) => {
      const v = verdicts.get(p.url)!;
      return { ...p, guess_band: v.guess_band, one_liner: v.one_liner };
    });
  kept.sort(
    (a, b) =>
      (BAND_ORDER[a.guess_band ?? "WEAK"] ?? 4) - (BAND_ORDER[b.guess_band ?? "WEAK"] ?? 4) ||
      b.rank_score - a.rank_score,
  );
  // One card per company: triage saw the company's candidates, the best-ranked
  // one represents it. Keeps the column varied instead of blocks of one firm.
  const seenCompanies = new Set<string>();
  const onePerCompany = kept.filter((p) => {
    const key = p.company.toLowerCase();
    if (seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });
  return { list: onePerCompany.slice(0, cap), triaged: true };
}
