/**
 * Sourcing sweep, local lane: thin driver over the engine's runSourcingSweep.
 * ALL user-specific criteria come from ~/Kairos (search-profile.json, derived
 * from profile.md on first run) — nothing personal lives in this file.
 * Triage runs headless through the Claude Code CLI (Max-billed); if the CLI is
 * unavailable the deterministic top-N ships instead, marked untriaged.
 *
 *   npm -w kairos-cloud run sourcing-run
 *   npm -w kairos-cloud run sourcing-run -- --max-boards 800   (cap for quick runs)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
import { boardFromUrl, runSourcingSweep } from "@kairos/engine/sourcing/sweep";
import {
  deriveSearchProfile,
  type CandidateProfileFrontmatter,
  type StoredSearchProfile,
} from "@kairos/engine/sourcing/search-profile";
import type { RegistryEntry } from "@kairos/engine/sourcing/types";
import { resolveRegistry } from "@kairos/engine/sourcing/registry-loader";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "../../../packages/engine/sourcing/registry.json");
const KAIROS = join(homedir(), "Kairos");
const OUT_DIR = join(KAIROS, "sourcing");

const argIdx = process.argv.indexOf("--max-boards");
const MAX_BOARDS = argIdx > -1 ? parseInt(process.argv[argIdx + 1], 10) : undefined;

// -- Search profile: stored file wins; first run derives from profile.md ------
mkdirSync(OUT_DIR, { recursive: true });
const profilePath = join(OUT_DIR, "search-profile.json");
let searchProfile: StoredSearchProfile;
if (existsSync(profilePath)) {
  searchProfile = JSON.parse(readFileSync(profilePath, "utf8"));
} else {
  const fm = existsSync(join(KAIROS, "profile.md"))
    ? (matter(readFileSync(join(KAIROS, "profile.md"), "utf8")).data as CandidateProfileFrontmatter)
    : {};
  searchProfile = deriveSearchProfile(fm);
  writeFileSync(profilePath, JSON.stringify(searchProfile, null, 2));
  console.log("▸ No search-profile.json yet — derived one from profile.md (edit via the preferences conversation).");
}

// -- Dedupe inputs + boards from the user's own applications ------------------
const APPS = join(KAIROS, "applications");
const knownApplications: { company: string; role: string }[] = [];
const seenUrls = new Set<string>(
  existsSync(join(OUT_DIR, "seen.json"))
    ? Object.keys(JSON.parse(readFileSync(join(OUT_DIR, "seen.json"), "utf8")))
    : [],
);
const extraBoards: RegistryEntry[] = [];
if (existsSync(APPS)) {
  for (const folder of readdirSync(APPS, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const metaPath = join(APPS, folder.name, "application-meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      company?: string; role?: string; source_url?: string;
    };
    if (meta.company && meta.role) knownApplications.push({ company: meta.company, role: meta.role });
    if (meta.source_url) {
      seenUrls.add(meta.source_url.split("?")[0]);
      const board = boardFromUrl(meta.source_url);
      if (board) extraBoards.push(board);
    }
  }
}

let profileSummary = "";
try {
  profileSummary = readFileSync(join(KAIROS, "profile.md"), "utf8").slice(0, 1500);
} catch {}
if (searchProfile.notes) profileSummary += `\n\nSourcing notes: ${searchProfile.notes}`;

const seed = JSON.parse(readFileSync(REGISTRY, "utf8"));
let dataCopy: unknown = null;
try { dataCopy = JSON.parse(readFileSync(join(OUT_DIR, "registry.json"), "utf8")); } catch {}
const resolved = resolveRegistry(dataCopy, seed);
if (resolved.source === "seed") console.log("▸ Registry: using committed seed (no harvested copy at ~/Kairos/sourcing/registry.json)");
if (resolved.staleness) console.error(`⚠️  ${resolved.staleness}`);
const registry = resolved.registry.entries;

console.log(`▸ Sweeping up to ${MAX_BOARDS ?? registry.length} boards · recency cap ${searchProfile.max_age_days}d`);
const result = await runSourcingSweep({
  registry,
  extraBoards,
  profile: searchProfile,
  seenUrls,
  knownApplications,
  profileSummary,
  maxBoards: MAX_BOARDS,
  onLog: (m) => console.log(`\n  ${m}`),
  onProgress: (done, total, postings) =>
    process.stdout.write(`\r  ${done}/${total} boards · ${postings} postings`),
  triage: async (prompt) => {
    const claude = process.env.CLAUDE_CLI_PATH || "claude";
    console.log(`\n▸ Triage via ${claude === "claude" ? "claude CLI" : claude}`);
    const { stdout } = await execFileAsync(claude, ["-p", prompt], {
      timeout: 8 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  },
});

writeFileSync(join(OUT_DIR, "last-run.json"), JSON.stringify(result, null, 1));

if (result.fetch_stats) {
  const s = result.fetch_stats;
  const hard = s.boards_failed + s.rate_limited;
  console.log(
    `▸ Fetch: ${s.boards_ok} ok · ${s.boards_gone} gone (registry decay) · ${s.boards_failed} failed · ${s.rate_limited} rate-limited`,
  );
  if (hard > 0 && hard / (s.boards_ok + s.boards_gone + hard) > 0.05) {
    console.error(`⚠️  FETCH DEGRADED — results may be incomplete. Failures by ATS: ${JSON.stringify(s.failures_by_ats)}`);
  }
}

if (result.triage_error) {
  const authExpired = /auth|oauth|expired|authenticate/i.test(result.triage_error);
  console.error(
    `\n⚠️  TRIAGE FAILED: ${result.triage_error}\n` +
      `   The list below is the UNRANKED deterministic fallback — it buries your\n` +
      `   priority roles (Chief of Staff, Group PM) instead of ranking them.\n` +
      (authExpired
        ? `   FIX: the Claude CLI login expired. Mint a long-lived headless token:\n` +
          `        claude setup-token\n` +
          `   Then re-run:  npm -w kairos-cloud run sourcing-run\n`
        : `   Check the triage model call and re-run.\n`),
  );
}

console.log(
  `\n▸ Shortlist${result.triaged ? "" : " (UNTRIAGED fallback)"}: ${result.survivors.length} matches + ${result.stretch.length} stretch (from ${result.postings_fetched} postings)`,
);
for (const p of result.survivors) {
  console.log(
    `  [${p.guess_band ?? "?"}|${p.age_days === null ? "?" : p.age_days + "d"}] ${p.company} — ${p.title} (${p.location || "n/a"})${p.one_liner ? ` · ${p.one_liner}` : ""}`,
  );
}
console.log("\nStretch (location mismatch, otherwise strong):");
for (const p of result.stretch) {
  console.log(
    `  [${p.guess_band ?? "?"}|${p.age_days === null ? "?" : p.age_days + "d"}] ${p.company} — ${p.title} (${p.location || "n/a"})${p.one_liner ? ` · ${p.one_liner}` : ""}`,
  );
}
console.log("\n✓ sourcing/last-run.json written; Sourced column reads it.");
