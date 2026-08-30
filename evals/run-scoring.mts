/**
 * Tier-2 scoring-calibration eval: run the real scoring prompt over fixture
 * job ads for the student-persona KB and assert band-level expectations.
 *
 *   npm run eval:scoring            (CLI provider by default; --api for API key)
 *   npm run eval:scoring -- --only staff-ml-research
 *
 * Costs real model spend; not part of CI. Writes evals/out/scoring-<date>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCORING_SYSTEM_PROMPT, buildScoringUserMessage } from "@kairos/engine/prompts/scoring";
import { ScoreReportSchema } from "@kairos/engine/tools/schemas";
import { AD_FIXTURES } from "./fixtures/ads";
import { FIXTURE_EDUCATION, callModel, extractJson, fixtureStore, pickProvider } from "./lib";

const provider = pickProvider(process.argv);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const fixtures = only ? AD_FIXTURES.filter((f) => f.id === only) : AD_FIXTURES;

const { experiences } = await fixtureStore();
console.log(`Scoring eval · provider=${provider} · fixtures=${fixtures.length} · persona=student-kb (${experiences.length} experiences)`);

interface Row {
  id: string;
  band: string | null;
  recommendation: string | null;
  pass: boolean;
  notes: string[];
}
const rows: Row[] = [];

for (const f of fixtures) {
  const prompt = `${SCORING_SYSTEM_PROMPT}\n\n${buildScoringUserMessage({
    jobText: f.jobText,
    detectedAts: "unknown",
    experiences,
    educationRaw: FIXTURE_EDUCATION,
    voiceProfile: null,
    recruiterFeedback: null,
    mode: "audit",
  })}\n\nReturn ONLY the ScoreReport JSON object. No prose, no code fences.`;

  const notes: string[] = [];
  let band: string | null = null;
  let rec: string | null = null;
  let pass = false;
  try {
    const raw = await callModel(provider, prompt);
    const parsed = ScoreReportSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      notes.push(`schema invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    } else {
      band = parsed.data.match.overall_band;
      rec = parsed.data.recommendation;
      pass = true;
      if (!f.expect.bands.includes(band)) {
        pass = false;
        notes.push(`band ${band} not in expected [${f.expect.bands.join(", ")}]`);
      }
      if (f.expect.forbidRecommendations?.includes(rec)) {
        pass = false;
        notes.push(`recommendation ${rec} is forbidden for this fixture`);
      }
      if (f.expect.requireRecommendations && !f.expect.requireRecommendations.includes(rec)) {
        pass = false;
        notes.push(`recommendation ${rec}, required one of [${f.expect.requireRecommendations.join(", ")}]`);
      }
    }
  } catch (e) {
    notes.push(`error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  rows.push({ id: f.id, band, recommendation: rec, pass, notes });
  console.log(`  ${pass ? "✓" : "✗"} ${f.id.padEnd(22)} band=${String(band).padEnd(12)} rec=${String(rec).padEnd(24)}${notes.length ? " · " + notes.join("; ") : ""}`);
}

const passed = rows.filter((r) => r.pass).length;
console.log(`\nScoring calibration: ${passed}/${rows.length} fixtures within expected bands`);
mkdirSync(join(process.cwd(), "evals", "out"), { recursive: true });
const outPath = join("evals", "out", `scoring-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outPath, JSON.stringify({ provider, at: new Date().toISOString(), rows }, null, 2));
console.log(`written: ${outPath}`);
process.exit(passed === rows.length ? 0 : 1);
