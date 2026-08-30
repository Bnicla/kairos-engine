/**
 * Tier-2 generation-regression eval: score a fixture ad, generate a résumé for
 * the student persona, and push it through the REAL guarded save path
 * (grounding audit, style gates, length floors) with one findings-fed retry —
 * reporting gate outcomes and retry counts per fixture.
 *
 *   npm run eval:generation             (defaults to the two good-fit fixtures)
 *   npm run eval:generation -- --only junior-swe-fintech
 *
 * Costs real model spend; not part of CI. Writes evals/out/generation-<date>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCORING_SYSTEM_PROMPT, buildScoringUserMessage } from "@kairos/engine/prompts/scoring";
import { GENERATION_SYSTEM_PROMPT, buildGenerationUserMessage } from "@kairos/engine/prompts/generation";
import { ScoreReportSchema } from "@kairos/engine/tools/schemas";
import { saveGeneratedResume, saveScoredReport } from "@kairos/engine/tools/ops";
import { createApplication } from "@kairos/engine/applications";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";
import { AD_FIXTURES } from "./fixtures/ads";
import { FIXTURE_EDUCATION, callModel, extractJson, fixtureStore, pickProvider } from "./lib";

const provider = pickProvider(process.argv);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const DEFAULT_IDS = ["junior-swe-fintech", "internal-tools-eng"];
const fixtures = AD_FIXTURES.filter((f) => (only ? f.id === only : DEFAULT_IDS.includes(f.id)));

const { store, experiences } = await fixtureStore();
console.log(`Generation eval · provider=${provider} · fixtures=${fixtures.length} · persona=student-kb`);

interface Row {
  id: string;
  scored: boolean;
  attempts: number;
  gateOutcome: "passed" | "failed" | "error";
  findings: string[];
  warnings: string[];
}
const rows: Row[] = [];

for (const f of fixtures) {
  const row: Row = { id: f.id, scored: false, attempts: 0, gateOutcome: "error", findings: [], warnings: [] };
  rows.push(row);
  try {
    // 1. Score (the generation prompt requires a report to reframe against).
    const scoreRaw = await callModel(
      provider,
      `${SCORING_SYSTEM_PROMPT}\n\n${buildScoringUserMessage({
        jobText: f.jobText, detectedAts: "unknown", experiences,
        educationRaw: FIXTURE_EDUCATION, voiceProfile: null, recruiterFeedback: null, mode: "audit",
      })}\n\nReturn ONLY the ScoreReport JSON object. No prose, no code fences.`,
    );
    const report = ScoreReportSchema.safeParse(extractJson(scoreRaw));
    if (!report.success) throw new Error(`score schema invalid: ${report.error.issues[0]?.message}`);
    row.scored = true;

    const meta = await createApplication(store, { company: f.id, role: f.title, snapshotMarkdown: f.jobText });
    await saveScoredReport(store, meta.id, "eval", report.data as ScoreReport);

    // 2. Generate → guarded save, one findings-fed retry (mirrors production).
    let prompt = `${GENERATION_SYSTEM_PROMPT}\n\n${buildGenerationUserMessage({
      jobText: f.jobText, detectedAts: "unknown", company: f.id, title: f.title,
      scoreReport: report.data as ScoreReport, experiences, educationRaw: FIXTURE_EDUCATION,
      voiceProfile: null, summaryBlocks: null, recruiterFeedback: null,
      candidateName: "Jordan Sample", contactLine: "Chicago, IL · jordan@example.com", targetPages: 1,
    })}\n\nReturn ONLY the GeneratedResume JSON object. No prose, no code fences.`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      row.attempts = attempt;
      const genRaw = await callModel(provider, prompt);
      const resume = extractJson(genRaw) as GeneratedResume;
      try {
        const result = await saveGeneratedResume(store, meta.id, resume, {});
        row.gateOutcome = "passed";
        row.warnings = result.warnings;
        break;
      } catch (err) {
        const findings = err instanceof Error ? err.message : String(err);
        row.findings.push(findings.slice(0, 200));
        if (attempt === 2) {
          row.gateOutcome = "failed";
        } else {
          prompt += `\n\nYour previous attempt was REJECTED by validation with these findings:\n${findings}\nFix every finding and return the corrected GeneratedResume JSON only.`;
        }
      }
    }
  } catch (e) {
    row.findings.push(`error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  console.log(
    `  ${row.gateOutcome === "passed" ? "✓" : "✗"} ${row.id.padEnd(22)} gates=${row.gateOutcome} attempts=${row.attempts}${row.warnings.length ? ` warnings=[${row.warnings.join(" | ").slice(0, 120)}]` : ""}${row.findings.length ? ` findings=[${row.findings.join(" | ").slice(0, 160)}]` : ""}`,
  );
}

const passed = rows.filter((r) => r.gateOutcome === "passed").length;
console.log(`\nGeneration regression: ${passed}/${rows.length} fixtures pass the guarded save path`);
mkdirSync(join(process.cwd(), "evals", "out"), { recursive: true });
const outPath = join("evals", "out", `generation-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outPath, JSON.stringify({ provider, at: new Date().toISOString(), rows }, null, 2));
console.log(`written: ${outPath}`);
process.exit(passed === rows.length ? 0 : 1);
