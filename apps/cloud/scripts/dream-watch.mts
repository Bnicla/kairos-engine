/**
 * Dream-company watcher: direct career-API monitoring for the companies the
 * user cares most about, INCLUDING the ones the board sweep cannot see
 * (Google and Microsoft run proprietary ATSes outside the registry).
 *
 * Hits each company's own JSON endpoint, filters titles through the same
 * function gate as the sweep, diffs against sourcing/dream-seen.json, and
 * writes sourcing/dream-watch.json (read by humans and by the daily log).
 * A source that fails is reported loudly, never silently skipped.
 *
 *   npm -w kairos-cloud run dream-watch
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { passesFunctionGate } from "@kairos/engine/sourcing/filter";
import type { SearchProfile } from "@kairos/engine/sourcing/types";

const OUT_DIR = join(homedir(), "Kairos", "sourcing");
mkdirSync(OUT_DIR, { recursive: true });
const profile: SearchProfile = JSON.parse(
  readFileSync(join(OUT_DIR, "search-profile.json"), "utf8"),
);

interface DreamJob {
  company: string;
  title: string;
  location: string;
  url: string;
}

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { ...UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Per-ATS fetchers ---------------------------------------------------------

async function greenhouse(company: string, org: string): Promise<DreamJob[]> {
  const d = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs`)) as {
    jobs?: { title: string; absolute_url: string; location?: { name?: string } }[];
  };
  return (d.jobs ?? []).map((j) => ({
    company, title: j.title, location: j.location?.name ?? "", url: j.absolute_url,
  }));
}

async function ashby(company: string, org: string): Promise<DreamJob[]> {
  const d = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${org}`)) as {
    jobs?: { title: string; location?: string; jobUrl?: string; isRemote?: boolean }[];
  };
  return (d.jobs ?? []).map((j) => ({
    company, title: j.title,
    location: `${j.location ?? ""}${j.isRemote ? " (Remote)" : ""}`,
    url: j.jobUrl ?? `https://jobs.ashbyhq.com/${org}`,
  }));
}

async function lever(company: string, org: string): Promise<DreamJob[]> {
  const d = (await getJson(`https://api.lever.co/v0/postings/${org}?mode=json`)) as
    { text: string; hostedUrl: string; categories?: { location?: string } }[];
  return (d ?? []).map((j) => ({
    company, title: j.text, location: j.categories?.location ?? "", url: j.hostedUrl,
  }));
}

// Google Careers: the old v3 JSON API is gone (404). The search RESULTS page
// still embeds every job as jobs/results/<id>-<title-slug> in the initial HTML,
// so we parse those. Titles are reconstructed from the slug (good enough for
// gating and alerts; the posting page has the real thing).
async function google(): Promise<DreamJob[]> {
  const out = new Map<string, DreamJob>();
  for (const q of ['"product manager"', '"chief of staff"', '"head of product"']) {
    const res = await fetch(
      `https://www.google.com/about/careers/applications/jobs/results?q=${encodeURIComponent(q)}&location=United%20States`,
      { headers: UA },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    for (const m of html.matchAll(/jobs\/results\/(\d{10,})-([a-z0-9-]+)/g)) {
      const [_, id, slug] = m;
      if (out.has(id)) continue;
      const title = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      out.set(id, {
        company: "Google", title,
        location: "United States (see posting)",
        url: `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}`,
      });
    }
  }
  return [...out.values()];
}

// Microsoft Careers: the JSON API behind jobs.careers.microsoft.com.
// KNOWN ISSUE: the gcsservices host (Azure Front Door) rejects non-browser TLS
// from this machine, so this source fails with a connection error. Kept so the
// failure stays VISIBLE in every run; Microsoft roles need a manual browser
// check until a workable path exists.
async function microsoft(): Promise<DreamJob[]> {
  const out: DreamJob[] = [];
  for (const q of ["product manager AI", "chief of staff AI"]) {
    const d = (await getJson(
      `https://gcsservices.careers.microsoft.com/search/api/v1/search?q=${encodeURIComponent(q)}&lc=United%20States&lg=en_us&pg=1&pgSz=50&o=Relevance&flt=true`,
    )) as { operationResult?: { result?: { jobs?: { jobId: string; title: string; properties?: { locations?: string[] } }[] } } };
    for (const j of d.operationResult?.result?.jobs ?? []) {
      out.push({
        company: "Microsoft", title: j.title,
        location: (j.properties?.locations ?? []).join("; "),
        url: `https://jobs.careers.microsoft.com/global/en/job/${j.jobId}`,
      });
    }
  }
  return out;
}

// --- Sources ------------------------------------------------------------------
// Meta is intentionally absent: metacareers.com is a GraphQL app with no stable
// public JSON surface. Revisit if that changes.
const SOURCES: [string, () => Promise<DreamJob[]>][] = [
  ["Google", google],
  ["Microsoft", microsoft],
  ["Anthropic", () => greenhouse("Anthropic", "anthropic")],
  ["OpenAI", () => ashby("OpenAI", "openai")],
  ["Scale AI", () => greenhouse("Scale AI", "scaleai")],
  ["DeepMind", () => greenhouse("DeepMind", "deepmind")],
  ["xAI", () => greenhouse("xAI", "xai")],
  ["Mistral", () => lever("Mistral", "mistral")],
  ["Databricks", () => greenhouse("Databricks", "databricks")],
  ["Perplexity", () => ashby("Perplexity", "Perplexity")],
  ["Cohere", () => ashby("Cohere", "cohere")],
];

// --- Run ----------------------------------------------------------------------
const seenPath = join(OUT_DIR, "dream-seen.json");
const seen: Record<string, string> = existsSync(seenPath)
  ? JSON.parse(readFileSync(seenPath, "utf8"))
  : {};
const firstRun = Object.keys(seen).length === 0;

const all: DreamJob[] = [];
const failures: string[] = [];
for (const [name, fn] of SOURCES) {
  try {
    const jobs = (await fn()).filter((j) => passesFunctionGate(j.title, profile));
    console.log(`  ${name}: ${jobs.length} relevant postings`);
    all.push(...jobs);
  } catch (e) {
    const msg = `${name}: FAILED (${e instanceof Error ? e.message : e})`;
    failures.push(msg);
    console.error(`  ! ${msg}`);
  }
}

const fresh = all.filter((j) => !seen[j.url]);
const now = new Date().toISOString();
for (const j of all) if (!seen[j.url]) seen[j.url] = now;
writeFileSync(seenPath, JSON.stringify(seen, null, 1));
writeFileSync(join(OUT_DIR, "dream-watch.json"), JSON.stringify(
  { ran_at: now, first_run: firstRun, sources_failed: failures, total: all.length, new: fresh },
  null, 1,
));

console.log(`\n▸ Dream watch: ${all.length} relevant roles across ${SOURCES.length - failures.length}/${SOURCES.length} sources`);
if (failures.length) console.log(`  ⚠ failed sources: ${failures.join(" | ")}`);
if (firstRun) {
  console.log(`  (first run: baseline recorded, ${all.length} roles marked seen; future runs report only NEW postings)`);
} else if (fresh.length) {
  console.log(`\n★ NEW since last run:`);
  for (const j of fresh) console.log(`  ${j.company} — ${j.title} (${j.location.slice(0, 60)})\n    ${j.url}`);
} else {
  console.log("  no new postings since last run");
}
