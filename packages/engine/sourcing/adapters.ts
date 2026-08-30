import type { Posting, RegistryEntry, SourcingAts } from "./types";

/**
 * Public ATS feed adapters. Every function talks DIRECTLY to the ATS's own
 * unauthenticated job-board endpoint (no intermediaries — spec §3/§4) and
 * returns a normalized Posting[]. A missing/renamed board resolves to [] —
 * sweep-time validation is how the registry self-cleans.
 */

const TIMEOUT_MS = 12_000;

/**
 * Typed fetch outcomes (REQ-6). A rate-limit event must be distinguishable from
 * "board has no jobs": swallowing errors made a throttled sweep look like a
 * quiet market. "gone" (404/410) is registry decay, not infrastructure failure —
 * accounted separately so the failure banner doesn't cry wolf on stale slugs.
 */
export type FetchFailureKind = "http" | "gone" | "rate_limited" | "timeout" | "network" | "parse";

export class BoardFetchError extends Error {
  constructor(
    public kind: FetchFailureKind,
    public status?: number,
  ) {
    super(`board fetch failed: ${kind}${status ? ` (${status})` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "kairos-sourcing/1.0", ...(init?.headers ?? {}) },
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new BoardFetchError(timedOut ? "timeout" : "network");
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new BoardFetchError("parse", res.status);
      }
    }
    // One retry with backoff + jitter on throttle/transient statuses, honoring
    // Retry-After when the host names a wait (capped so a sweep can't stall).
    if ((res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : 500 + Math.random() * 700;
      await sleep(wait);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new BoardFetchError("gone", res.status);
    if (res.status === 429) throw new BoardFetchError("rate_limited", res.status);
    throw new BoardFetchError("http", res.status);
  }
}

const iso = (d: Date | number | string | null | undefined): string | null => {
  if (d === null || d === undefined) return null;
  const date = new Date(d);
  return isNaN(date.getTime()) ? null : date.toISOString();
};

const ageDays = (posted: string | null, now: number): number | null =>
  posted === null ? null : Math.max(0, Math.floor((now - new Date(posted).getTime()) / 86_400_000));

function mk(
  base: Omit<Posting, "age_days" | "remote"> & { remote?: boolean },
  now: number,
): Posting {
  const remote = base.remote ?? /remote|anywhere|distributed/i.test(base.location);
  return { ...base, remote, age_days: ageDays(base.posted_at, now) };
}

const titleize = (slug: string) =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// -- Greenhouse ---------------------------------------------------------------

async function fetchGreenhouse(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)) as {
    jobs?: { absolute_url?: string; title?: string; updated_at?: string; location?: { name?: string } }[];
  } | null;
  if (!data?.jobs) return [];
  return data.jobs
    .filter((j) => j.title && j.absolute_url)
    .map((j) =>
      mk(
        {
          ats: "greenhouse",
          slug,
          company: titleize(slug),
          title: j.title!,
          url: j.absolute_url!,
          location: j.location?.name ?? "",
          // Greenhouse's public feed exposes updated_at, not first-published —
          // an upper bound on freshness. Honest enough for a 7-day gate.
          posted_at: iso(j.updated_at ?? null),
        },
        now,
      ),
    );
}

// -- Lever --------------------------------------------------------------------

async function fetchLever(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as
    | { hostedUrl?: string; text?: string; createdAt?: number; categories?: { location?: string }; workplaceType?: string }[]
    | null;
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => j.text && j.hostedUrl)
    .map((j) =>
      mk(
        {
          ats: "lever",
          slug,
          company: titleize(slug),
          title: j.text!,
          url: j.hostedUrl!,
          location: j.categories?.location ?? "",
          remote: j.workplaceType === "remote" || undefined,
          posted_at: iso(j.createdAt ?? null),
        },
        now,
      ),
    );
}

// -- Ashby --------------------------------------------------------------------

async function fetchAshby(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)) as {
    jobs?: {
      title?: string;
      location?: string;
      isRemote?: boolean;
      publishedAt?: string;
      publishedDate?: string;
      jobUrl?: string;
      applyUrl?: string;
    }[];
  } | null;
  if (!data?.jobs) return [];
  return data.jobs
    .filter((j) => j.title && (j.jobUrl || j.applyUrl))
    .map((j) =>
      mk(
        {
          ats: "ashby",
          slug,
          company: titleize(slug),
          title: j.title!,
          url: (j.jobUrl ?? j.applyUrl)!,
          location: j.location ?? "",
          remote: j.isRemote || undefined,
          posted_at: iso(j.publishedAt ?? j.publishedDate ?? null),
        },
        now,
      ),
    );
}

// -- Rippling -----------------------------------------------------------------

async function fetchRippling(slug: string, now: number): Promise<Posting[]> {
  const data = (await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`)) as
    | { name?: string; title?: string; url?: string; workLocation?: { label?: string }; locations?: { label?: string }[] }[]
    | null;
  if (!Array.isArray(data)) return [];
  return data
    .filter((j) => (j.name || j.title) && j.url)
    .map((j) =>
      mk(
        {
          ats: "rippling",
          slug,
          company: titleize(slug),
          title: (j.name ?? j.title)!,
          url: j.url!,
          location: j.workLocation?.label ?? j.locations?.map((l) => l.label).join(" / ") ?? "",
          posted_at: null, // Rippling's public board feed carries no post date.
        },
        now,
      ),
    );
}

// -- Workday ------------------------------------------------------------------

/** "Posted Today" → 0, "Posted Yesterday" → 1, "Posted 6 Days Ago" → 6, "30+ Days Ago" → 31. */
export function parseWorkdayPostedOn(postedOn: string | undefined, now: number): string | null {
  if (!postedOn) return null;
  const p = postedOn.toLowerCase();
  let days: number | null = null;
  if (p.includes("today")) days = 0;
  else if (p.includes("yesterday")) days = 1;
  else if (p.includes("30+")) days = 31;
  else {
    const m = p.match(/(\d+)\+?\s+days?\s+ago/);
    if (m) days = parseInt(m[1], 10);
  }
  return days === null ? null : new Date(now - days * 86_400_000).toISOString();
}

async function fetchWorkday(composite: string, now: number): Promise<Posting[]> {
  // slug format: tenant@wdN@site
  const [tenant, wd, site] = composite.split("@");
  if (!tenant || !wd || !site) return [];
  const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const data = (await getJson(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "product" }),
  })) as { jobPostings?: { title?: string; externalPath?: string; locationsText?: string; postedOn?: string }[] } | null;
  if (!data?.jobPostings) return [];
  return data.jobPostings
    .filter((j) => j.title && j.externalPath)
    .map((j) =>
      mk(
        {
          ats: "workday",
          slug: composite,
          company: titleize(tenant),
          title: j.title!,
          url: `${base}/en-US/${site}${j.externalPath}`,
          location: j.locationsText ?? "",
          posted_at: parseWorkdayPostedOn(j.postedOn, now),
        },
        now,
      ),
    );
}

// -- dispatch -----------------------------------------------------------------

const ADAPTERS: Record<SourcingAts, (slug: string, now: number) => Promise<Posting[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  rippling: fetchRippling,
  workday: fetchWorkday,
};

export interface BoardFetchResult {
  postings: Posting[];
  /** Present when the board could not be read; postings is then []. */
  failure?: { kind: FetchFailureKind; status?: number };
}

/** Fetch one board with a typed outcome — failures are reported, never swallowed. */
export async function fetchBoardDetailed(entry: RegistryEntry, now = Date.now()): Promise<BoardFetchResult> {
  try {
    return { postings: await ADAPTERS[entry.ats](entry.slug, now) };
  } catch (err) {
    if (err instanceof BoardFetchError) {
      return { postings: [], failure: { kind: err.kind, status: err.status } };
    }
    return { postings: [], failure: { kind: "network" } };
  }
}

/** Back-compat form: failures resolve to []. Prefer fetchBoardDetailed. */
export async function fetchBoard(entry: RegistryEntry, now = Date.now()): Promise<Posting[]> {
  return (await fetchBoardDetailed(entry, now)).postings;
}
