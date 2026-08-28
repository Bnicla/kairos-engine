/**
 * Job ad ingestion (§26). URL fetch is best-effort; paste is the always-available
 * fallback. Whatever we successfully ingest becomes the preserved snapshot.
 */

export interface IngestedAd {
  markdown: string; // the snapshot body written to job-ad-snapshot.md
  text: string; // plain text for scoring
  meta: {
    company?: string;
    title?: string;
    source_url?: string;
    location?: string;
    req_id?: string;
  };
}

/** Strip HTML to readable text (server-side, no DOM). Best-effort. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -- ATS JSON adapters --------------------------------------------------------
// Ashby and Workday job pages are client-rendered, so the generic HTML fetch
// gets nothing; their unauthenticated posting APIs carry the full text. Tried
// by URL pattern BEFORE the HTML fetch. A null return falls through.

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (compatible; KairosBot/1.0; +https://kairos.app)",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function adFromParts(parts: {
  title: string;
  source_url: string;
  location?: string;
  remote?: boolean;
  compensation?: string;
  body: string;
}): IngestedAd {
  const header = [
    `# ${parts.title}`,
    parts.location ? `Location: ${parts.location}${parts.remote ? " (remote)" : ""}` : parts.remote ? "Location: Remote" : null,
    parts.compensation ? `Compensation: ${parts.compensation}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${header}\n\n${parts.body.trim()}`;
  return {
    text,
    markdown: buildSnapshotMarkdown({ text, source_url: parts.source_url, pageTitle: parts.title }),
    meta: { source_url: parts.source_url, title: parts.title, location: parts.location },
  };
}

/** https://jobs.ashbyhq.com/{org}/{jobId} → posting API (descriptionPlain). */
async function fetchAshbyAd(url: string): Promise<IngestedAd | null> {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  const [, org, jobId] = m;
  const data = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
  )) as {
    jobs?: {
      id?: string;
      title?: string;
      location?: string;
      isRemote?: boolean;
      jobUrl?: string;
      applyUrl?: string;
      compensation?: { compensationTierSummary?: string };
      descriptionPlain?: string;
    }[];
  } | null;
  // Match by ID (boards can carry near-identical titles), via the id field or
  // the job's own URLs.
  const job = data?.jobs?.find(
    (j) =>
      j.id?.toLowerCase() === jobId.toLowerCase() ||
      j.jobUrl?.includes(jobId) ||
      j.applyUrl?.includes(jobId),
  );
  if (!job?.title || !job.descriptionPlain) return null;
  return adFromParts({
    title: job.title,
    source_url: url,
    location: job.location,
    remote: job.isRemote,
    compensation: job.compensation?.compensationTierSummary,
    body: job.descriptionPlain,
  });
}

/** https://{tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}/job/{location}/{slug} → cxs job API. */
async function fetchWorkdayAd(url: string): Promise<IngestedAd | null> {
  const m = url.match(
    /^https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/([^/?#]+)\/([^/?#]+)/,
  );
  if (!m) return null;
  const [, tenant, wd, site, jobLocation, slug] = m;
  const data = (await getJson(
    `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobLocation}/${slug}`,
  )) as {
    jobPostingInfo?: { title?: string; location?: string; jobDescription?: string };
  } | null;
  const job = data?.jobPostingInfo;
  if (!job?.title || !job.jobDescription) return null;
  return adFromParts({
    title: job.title,
    source_url: url,
    location: job.location,
    body: htmlToText(job.jobDescription),
  });
}

/** Greenhouse board URL → boards-api JSON. Fallback only — the HTML page usually works. */
async function fetchGreenhouseAd(url: string): Promise<IngestedAd | null> {
  let org: string | undefined;
  let id: string | undefined;
  const embed = url.match(/greenhouse\.io\/embed\/job_app\?([^#]+)/i);
  if (embed) {
    const q = new URLSearchParams(embed[1]);
    org = q.get("for") ?? undefined;
    id = q.get("token") ?? undefined;
  } else {
    const board = url.match(/greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i);
    if (board) [, org, id] = board;
  }
  if (!org || !id) return null;
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}`)) as {
    title?: string;
    location?: { name?: string };
    content?: string;
  } | null;
  if (!data?.title || !data.content) return null;
  // Greenhouse ships content as entity-escaped HTML — unescape, then strip.
  const html = data.content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return adFromParts({
    title: data.title,
    source_url: url,
    location: data.location?.name,
    body: htmlToText(html),
  });
}

export async function fetchJobAd(url: string): Promise<IngestedAd> {
  // ATS APIs first: exact structured text where the HTML page is JS-rendered.
  const viaApi = (await fetchAshbyAd(url)) ?? (await fetchWorkdayAd(url));
  if (viaApi) return viaApi;

  let htmlError: Error | null = null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; KairosBot/1.0; +https://kairos.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    if (text.length < 200) {
      throw new Error(
        "Fetched page had almost no readable text (likely JS-rendered or login-gated). Paste the text instead.",
      );
    }
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "").trim();
    return {
      text,
      markdown: buildSnapshotMarkdown({ text, source_url: url, pageTitle: title }),
      meta: { source_url: url },
    };
  } catch (e) {
    htmlError = e instanceof Error ? e : new Error(String(e));
  }

  // HTML failed — Greenhouse's boards API can still rescue a board URL.
  const viaGreenhouse = await fetchGreenhouseAd(url);
  if (viaGreenhouse) return viaGreenhouse;
  throw htmlError;
}

export function ingestPastedText(
  text: string,
  hint?: { company?: string; title?: string; source_url?: string },
): IngestedAd {
  return {
    text: text.trim(),
    markdown: buildSnapshotMarkdown({ text: text.trim(), source_url: hint?.source_url }),
    meta: { ...hint },
  };
}

function buildSnapshotMarkdown(input: {
  text: string;
  source_url?: string;
  pageTitle?: string;
}): string {
  const captured_at = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `captured_at: "${captured_at}"`,
    input.source_url ? `source_url: ${input.source_url}` : "source: pasted",
    input.pageTitle ? `page_title: ${JSON.stringify(input.pageTitle)}` : null,
    'capture_note: "Full text snapshot preserved so the candidate can review pre-interview even if the posting is removed."',
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${frontmatter}\n\n${input.text}\n`;
}
