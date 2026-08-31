/**
 * Real-Drive end-to-end check for the cloud lane's store (Phase 1 exit test).
 *
 * Run it YOURSELF with your own Google OAuth access token (drive.file scope):
 *
 *   GOOGLE_ACCESS_TOKEN="ya29...." npm -w kairos-cloud run drive-e2e
 *
 * Easiest token source while the auth UI doesn't exist yet:
 * https://developers.google.com/oauthplayground → authorize
 * "https://www.googleapis.com/auth/drive.file" → Exchange for access token.
 *
 * It uses a throwaway root folder ("Kairos-e2e") so your real data is never
 * touched, runs: initTree → seed one KB experience → capture a job ad →
 * guarded score save → guarded resume save (grounding + style + ATS) →
 * reads everything back, then prints what to delete (one folder).
 */
import { DriveStore } from "../store/drive";
import { createApplication } from "@kairos/engine/applications";
import { saveScoredReport, saveGeneratedResume } from "@kairos/engine/tools/ops";
import type { ScoreReport } from "@kairos/engine/types";

const token = process.env.GOOGLE_ACCESS_TOKEN;
if (!token) {
  console.error("Set GOOGLE_ACCESS_TOKEN (drive.file scope). See header comment for how.");
  process.exit(1);
}

const store = DriveStore.fromAccessToken(token, { rootName: "Kairos-e2e" });
const step = (s: string) => console.log(`\n▸ ${s}`);

step("initTree — creating Kairos-e2e/ layout");
await store.initTree();

step("seed KB experience");
await store.writeFile(
  ["knowledge-base", "experiences", "01-acme-pm.md"],
  `---
id: acme-pm
company: Acme
title: Product Manager
start: '2020'
end: '2022'
---

## Achievements
- Delivered $20M in savings and 90% adoption on the support platform. [R]
`,
);

step("capture job ad (snapshot-first)");
const meta = await createApplication(store, {
  company: "Globex",
  role: "Head of Product",
  snapshotMarkdown: "# Head of Product\nPlatform adoption and support experience at scale.",
  source_url_unavailable: true,
});
console.log("  appId:", meta.id);

step("guarded score save");
const report: ScoreReport = {
  parse_safety: { verdict: "PASS", checks: [], ats_specific_note: "e2e" },
  match: {
    detected_ats: "e2e",
    dimensions: [{ name: "hard_skills", score: 70, justification: "e2e" }],
    overall_band: "COMPETITIVE",
    confidence: "medium",
    pool_caveat: "E2E check only; band reflects nothing real here.",
  },
  authenticity: { score: 90, flags: [], strengths: [] },
  gaps: [],
  reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "" },
  recommendation: "APPLY",
};
await saveScoredReport(store, meta.id, "Default résumé", report);

step("guarded resume save (grounding + style + ATS over Drive)");
const result = await saveGeneratedResume(store, meta.id, {
  resume: {
    header: { name: "E2E", contact: "nowhere" },
    executive_summary: "- **Product leader:** ships platforms with measured outcomes.",
    experience: [
      { company: "Acme", title: "Product Manager", dates: "2020 – 2022", bullets: ["Delivered $20M in savings and 90% adoption."] },
    ],
    education: [],
    skills: ["Platforms"],
  },
  provenance_audit: [{ claim: "savings", source_experience: "01-acme-pm", prov: "R" }],
});
console.log("  ATS coverage:", `${(result.ats.coverage * 100).toFixed(0)}%`, "warnings:", result.warnings.length);

step("read-back verification");
const idx = await store.readJson<{ applications: { id: string; status: string }[] }>(["_index.json"]);
const docx = await store.readBinary(["applications", meta.id, "resume.docx"]);
console.log("  index status:", idx?.applications[0]?.status, "| resume.docx bytes:", docx?.length);

console.log(
  "\n✅ E2E complete. Everything ran against your real Drive under 'Kairos-e2e/'.\n   Clean up by deleting that one folder in Drive.",
);
