/**
 * Registry harvester (spec §4): query the Common Crawl URL index (free public
 * dataset) for the fixed URL shapes of the five ATSs, extract board slugs, and
 * emit packages/engine/sourcing/registry.json. No paid intermediaries — the
 * only external dependency is the nonprofit Common Crawl index; validation
 * happens implicitly at sweep time against the ATS feeds themselves.
 *
 *   npm -w kairos-cloud run harvest-registry              (sampled, fast)
 *   npm -w kairos-cloud run harvest-registry -- --pages 60 (more coverage)
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/sourcing/registry.json");
const MAX_PAGES_PER_PATTERN = parseInt(process.argv[process.argv.indexOf("--pages") + 1] || "24", 10) || 24;

interface Pattern {
  ats: "greenhouse" | "lever" | "ashby" | "rippling" | "workday";
  query: string;
  extract: (url: string) => string | null;
}

const PATTERNS: Pattern[] = [
  {
    ats: "greenhouse",
    query: "boards.greenhouse.io/*",
    extract: (u) => u.match(/boards\.greenhouse\.io\/([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? null,
  },
  {
    ats: "lever",
    query: "jobs.lever.co/*",
    extract: (u) => u.match(/jobs\.lever\.co\/([a-zA-Z0-9-]+)/)?.[1]?.toLowerCase() ?? null,
  },
  {
    ats: "ashby",
    query: "jobs.ashbyhq.com/*",
    extract: (u) => {
      const m = u.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9-%.]+)/)?.[1];
      if (!m || m.includes("%")) return null;
      return decodeURIComponent(m).toLowerCase();
    },
  },
  {
    ats: "rippling",
    query: "ats.rippling.com/*",
    extract: (u) => {
      const m = u.match(/ats\.rippling\.com\/([a-zA-Z0-9-]+)\//)?.[1]?.toLowerCase();
      return m && m !== "api" ? m : null;
    },
  },
  {
    ats: "workday",
    query: "*.myworkdayjobs.com",
    extract: (u) => {
      // https://{tenant}.{wdN}.myworkdayjobs.com/(<lang>/)?{site}/job/... → tenant@wdN@site
      const m = u.match(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Za-z]{2})\/)?([A-Za-z0-9_-]+)(?:\/|$)/);
      if (!m) return null;
      const [, tenant, wd, , site] = m;
      if (!site || ["wday", "job", "jobs", "login"].includes(site.toLowerCase())) return null;
      return `${tenant}@${wd}@${site}`;
    },
  },
];

async function latestCrawl(): Promise<string> {
  const res = await fetch("https://index.commoncrawl.org/collinfo.json");
  const info = (await res.json()) as { id: string }[];
  return info[0].id;
}

async function fetchPage(crawl: string, query: string, page: number): Promise<string[]> {
  const url = `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(query)}&output=json&fl=url&page=${page}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return []; // past the last page
      if (res.status === 503) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return [];
      const text = await res.text();
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return (JSON.parse(line) as { url: string }).url;
          } catch {
            return "";
          }
        })
        .filter(Boolean);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

async function numPages(crawl: string, query: string): Promise<number> {
  const url = `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(query)}&output=json&showNumPages=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const data = (await res.json()) as { pages?: number };
    return data.pages ?? 1;
  } catch {
    return 1;
  }
}

const crawl = await latestCrawl();
console.log(`▸ Using crawl ${crawl}; up to ${MAX_PAGES_PER_PATTERN} index pages per pattern`);

const registry = new Map<string, { ats: string; slug: string }>();
if (existsSync(OUT)) {
  for (const e of JSON.parse(readFileSync(OUT, "utf8")).entries as { ats: string; slug: string }[]) {
    registry.set(`${e.ats}:${e.slug}`, e);
  }
  console.log(`▸ Merging into existing registry (${registry.size} entries)`);
}

for (const pattern of PATTERNS) {
  const total = await numPages(crawl, pattern.query);
  // Sample pages evenly across the alphabetically-ordered index for coverage.
  const take = Math.min(MAX_PAGES_PER_PATTERN, total);
  const step = total / take;
  const pages = [...new Set(Array.from({ length: take }, (_, i) => Math.floor(i * step)))];
  let found = 0;
  for (const page of pages) {
    const urls = await fetchPage(crawl, pattern.query, page);
    for (const u of urls) {
      const slug = pattern.extract(u);
      if (!slug) continue;
      const key = `${pattern.ats}:${slug}`;
      if (!registry.has(key)) {
        registry.set(key, { ats: pattern.ats, slug });
        found++;
      }
    }
    process.stdout.write(`\r  ${pattern.ats}: ${found} new slugs (${pages.indexOf(page) + 1}/${pages.length} pages, ${total} total in index)`);
  }
  console.log();
}

const entries = [...registry.values()].sort((a, b) => `${a.ats}:${a.slug}`.localeCompare(`${b.ats}:${b.slug}`));
writeFileSync(OUT, JSON.stringify({ version: 1, harvested_at: new Date().toISOString(), crawl, entries }, null, 1));
const byAts = entries.reduce<Record<string, number>>((acc, e) => ((acc[e.ats] = (acc[e.ats] ?? 0) + 1), acc), {});
console.log(`✓ registry.json: ${entries.length} boards`, byAts);
