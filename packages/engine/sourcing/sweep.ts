/**
 * The sourcing sweep pipeline, lane-agnostic: boards → parallel fetch →
 * prefilter (dedupe vs applications + seen) → triage (injected model call) →
 * shortlist. The local script drives it with the Claude CLI (Max-billed);
 * the cloud route drives it with the student's API key. NO user-specific
 * criteria live here — the SearchProfile is data, loaded per user.
 */

import { fetchBoard } from "./adapters";
import { prefilterAndRank } from "./filter";
import { applyTriage, buildTriagePrompt, parseTriageResponse, type TriageVerdict } from "./triage";
import type { Posting, RankedPosting, RegistryEntry, SearchProfile } from "./types";

export interface SweepInput {
  registry: RegistryEntry[];
  /** Boards derived from the user's own applications — always swept first. */
  extraBoards?: RegistryEntry[];
  profile: SearchProfile;
  /** URLs to drop: previously seen/dismissed + already-tracked applications. */
  seenUrls: Set<string>;
  knownApplications: { company: string; role: string }[];
  /** Candidate summary for the triage prompt (top of profile.md). */
  profileSummary: string;
  /** Lane-specific model call: takes the triage prompt, returns raw text. Omit → deterministic top-N. */
  triage?: (prompt: string) => Promise<string>;
  maxBoards?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number, postings: number) => void;
  /** Diagnostics channel (e.g. why triage fell back). Silent-swallow is worse. */
  onLog?: (message: string) => void;
  now?: () => string;
}

export interface SweepResultFile {
  version: 1;
  ran_at: string;
  boards_swept: number;
  postings_fetched: number;
  prefilter_matches: number;
  prefilter_stretch: number;
  triaged: boolean;
  /**
   * When triage was requested but failed, the reason (e.g. expired CLI auth).
   * Null on a clean run. Lets the Sourced page warn that the list is the
   * UNRANKED deterministic fallback instead of silently degrading — the
   * fallback buries priority roles (Chief of Staff, Group PM) the model would
   * have surfaced. null/absent = triage ran (or was never requested).
   */
  triage_error?: string | null;
  profile: SearchProfile;
  survivors: RankedPosting[];
  stretch: RankedPosting[];
  /**
   * Roles that cleared the mechanical prefilter (function/location/recency) but
   * did NOT reach the final board — cut by the triage input cap, the triage
   * verdict, the one-per-company rule, or the final size cap. Surfaced on the
   * "view all sourced" page so a human can rescue a good role the squeeze
   * dropped. Each carries a `drop_reason`. Ranked best-first, bounded.
   */
  dropped: RankedPosting[];
}

/** Board registry entry from a job-ad URL, for the ATSes with public feeds. */
export function boardFromUrl(url: string | undefined): RegistryEntry | null {
  if (!url) return null;
  let m = url.match(/greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\/\d+/);
  if (m) return { ats: "greenhouse", slug: m[1].toLowerCase() };
  m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\//);
  if (m) return { ats: "ashby", slug: m[1] };
  m = url.match(/jobs\.lever\.co\/([^/]+)\//);
  if (m) return { ats: "lever", slug: m[1] };
  m = url.match(/ats\.rippling\.com\/([^/]+)\/jobs\//);
  if (m) return { ats: "rippling", slug: m[1] };
  return null;
}

const ghId = (u: string): string | null =>
  u.match(/gh_jid=(\d{6,})/)?.[1] ?? u.match(/greenhouse\.io\/[^/]+\/jobs\/(\d{6,})/)?.[1] ?? null;

export async function runSourcingSweep(input: SweepInput): Promise<SweepResultFile> {
  const concurrency = input.concurrency ?? 24;
  const dedup = new Map<string, RegistryEntry>();
  for (const e of [...(input.extraBoards ?? []), ...input.registry]) {
    dedup.set(`${e.ats}:${e.slug}`, e);
  }
  const boards = [...dedup.values()].slice(
    0,
    input.maxBoards === undefined ? undefined : input.maxBoards + (input.extraBoards?.length ?? 0),
  );

  const all: Posting[] = [];
  let done = 0;
  const queue = [...boards];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          all.push(...(await fetchBoard(entry)));
        } catch {
          /* dead board — registry self-cleans at harvest time */
        }
        done++;
        if (done % 100 === 0) input.onProgress?.(done, boards.length, all.length);
      }
    }),
  );
  input.onProgress?.(done, boards.length, all.length);

  // Greenhouse jobs surface under two hosts (job-boards.greenhouse.io and the
  // company careers page with ?gh_jid=) — dedupe tracked jobs by job id too.
  const knownGhIds = new Set<string>();
  for (const u of input.seenUrls) {
    const id = ghId(u);
    if (id) knownGhIds.add(id);
  }
  const notTracked = (p: Posting) => {
    const id = ghId(p.url);
    return !id || !knownGhIds.has(id);
  };

  const pre = prefilterAndRank(all, input.profile, input.seenUrls, input.knownApplications);
  const survivors = pre.survivors.filter(notTracked);
  const stretch = pre.stretch.filter(notTracked);

  const TRIAGE_INPUT = 120;
  const candidates = [...survivors.slice(0, TRIAGE_INPUT), ...stretch.slice(0, 40)];
  let verdicts = new Map<string, TriageVerdict>();
  let triageError: string | null = null;
  if (input.triage && candidates.length > 0) {
    try {
      const raw = await input.triage(buildTriagePrompt(candidates, input.profileSummary));
      verdicts = parseTriageResponse(raw, new Set(candidates.map((c) => c.url)));
      if (verdicts.size === 0) {
        triageError = "triage returned no parseable verdicts";
        input.onLog?.(`${triageError}; shipping deterministic top-N`);
      }
    } catch (err) {
      // Deterministic top-N ships, marked untriaged — but say WHY, and record it
      // so the failure surfaces to the user instead of silently degrading.
      triageError = err instanceof Error ? err.message.split("\n")[0] : String(err);
      input.onLog?.(`triage unavailable (${triageError}); shipping deterministic top-N`);
    }
  }

  const finalMatches = applyTriage(survivors, verdicts, 25);
  const finalStretch = applyTriage(stretch, verdicts, 10);

  // "View all sourced": every prefilter survivor that did NOT make the final
  // board, tagged with why it was cut. These already cleared the mechanical
  // gates, so each is a plausible role a human might want to rescue.
  const DROPPED_CAP = 300;
  const reviewed = new Set(candidates.map((c) => c.url)); // reached triage
  const onBoard = new Set([...finalMatches.list, ...finalStretch.list].map((p) => p.url));
  const dropReason = (p: RankedPosting): RankedPosting["drop_reason"] => {
    if (!reviewed.has(p.url)) return "over_cap";
    const v = verdicts.get(p.url);
    if (v && v.verdict !== "SHORTLIST") return "triage_cut";
    // Shortlisted (or triage unavailable) but still not on the board: the
    // one-per-company rule took the slot, else it fell below the size cap.
    const onBoardCompanies = new Set([...finalMatches.list, ...finalStretch.list].map((x) => x.company.toLowerCase()));
    return onBoardCompanies.has(p.company.toLowerCase()) ? "same_company" : "below_cut";
  };
  const dropped: RankedPosting[] = [...survivors, ...stretch]
    .filter((p) => !onBoard.has(p.url))
    .map((p) => {
      const v = verdicts.get(p.url);
      return { ...p, drop_reason: dropReason(p), guess_band: v?.guess_band, one_liner: v?.one_liner };
    })
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, DROPPED_CAP);

  return {
    version: 1,
    ran_at: (input.now ?? (() => new Date().toISOString()))(),
    boards_swept: boards.length,
    postings_fetched: all.length,
    prefilter_matches: survivors.length,
    prefilter_stretch: stretch.length,
    triaged: finalMatches.triaged,
    triage_error: triageError,
    profile: input.profile,
    survivors: finalMatches.list,
    stretch: finalStretch.list,
    dropped,
  };
}
