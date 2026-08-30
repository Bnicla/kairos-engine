import type { Store } from "@kairos/engine/store/types";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";
import { appendScoreVersion, readSnapshot, saveResumeSource, updateMeta } from "@kairos/engine/applications";
import { loadExperiences } from "@kairos/engine/kb/store";
import { generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import { markdownResumeToDocx, type TemplateSpec } from "@kairos/engine/docx-render";
import { GeneratedResumeSchema, ScoreReportSchema, formatIssues } from "@kairos/engine/tools/schemas";
import {
  checkAtsCoverage,
  checkResumeGrounding,
  checkStyle,
  isHardStyleViolation,
  type AtsCoverage,
  type StyleViolation,
} from "@kairos/engine/tools/checks";

/**
 * The guarded high-level API — the ONLY sanctioned way to persist model-authored
 * artifacts. Both the MCP server and any operator script must call these; the
 * raw writers in lib/applications.ts are plumbing, not an API. This is where the
 * product's guarantees actually live:
 *   - runtime schema validation (zod) with actionable errors
 *   - mechanical grounding against the [?]-stripped KB (anti-fabrication, N1)
 *   - machine-checked house style (N5) and ATS-coverage reporting
 *   - resume.json / resume-source.md / resume.docx written together (no desync)
 *   - status + band bookkeeping in one place
 */

export async function saveScoredReport(
  store: Store,
  appId: string,
  label: string,
  report: ScoreReport,
): Promise<{ versionLabel: string }> {
  const parsed = ScoreReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`ScoreReport failed validation: ${formatIssues(parsed.error)}`);
  }
  await appendScoreVersion(store, appId, label, report);
  await updateMeta(store, appId, {
    status: "scored",
    score_band: report.match.overall_band,
    score_confidence: report.match.confidence,
    recommendation: report.recommendation,
  });
  return { versionLabel: label };
}

export interface SaveResumeResult {
  /** Advisory findings the caller should surface (not blocking). */
  warnings: string[];
  ats: AtsCoverage;
  style: StyleViolation[];
  provenanceEntries: number;
}

export async function saveGeneratedResume(
  store: Store,
  appId: string,
  gen: GeneratedResume,
  opts: {
    headline?: string;
    /** Per-user design overrides (DEC-8: uploaded template, design only). */
    template?: Partial<TemplateSpec>;
    /** Escape hatch for a metric the KB genuinely holds in another wording — logs a warning instead of failing. */
    allowUngroundedMetrics?: boolean;
  } = {},
): Promise<SaveResumeResult> {
  const parsed = GeneratedResumeSchema.safeParse(gen);
  if (!parsed.success) {
    throw new Error(`GeneratedResume failed validation: ${formatIssues(parsed.error)}`);
  }

  // Grounding (N1): employers, metrics, and provenance sources must trace to
  // verified KB evidence. Profile + education are legitimate curated sources.
  const experiences = await loadExperiences(store);
  const extraCorpus = [
    (await store.readFile(["profile.md"])) ?? "",
    (await store.readFile(["base-resume.md"])) ?? "",
  ].join("\n");
  const grounding = checkResumeGrounding(gen, experiences, extraCorpus);
  const warnings: string[] = [];
  const hardGrounding = grounding.filter(
    (g) =>
      (g.kind !== "ungrounded_metric" && g.kind !== "metric_source_mismatch") ||
      !opts.allowUngroundedMetrics,
  );
  if (hardGrounding.length) {
    throw new Error(
      `Resume failed grounding against the knowledge base: ${hardGrounding.map((g) => `[${g.kind}] ${g.detail}`).join("; ")}`,
    );
  }
  for (const g of grounding) warnings.push(`[${g.kind}] ${g.detail}`);

  // House style (N5): em dashes / banned words / "not just X but Y" block the save.
  const md = generatedResumeToMarkdown(gen);
  const style = checkStyle(md);
  const hardStyle = style.filter(isHardStyleViolation);
  if (hardStyle.length) {
    throw new Error(`Resume violates house style: ${hardStyle.map((v) => `${v.rule} (${v.detail})`).join("; ")}`);
  }
  for (const v of style) warnings.push(`style: ${v.rule} (${v.detail})`);

  // Page-fill safety net (portable). The AUTHORITATIVE check is the visual
  // layout probe (renders the docx, measures real page fill) where LibreOffice
  // is available; this word count is the coarse fallback for the cloud lane and
  // for catching grossly-short resumes. Calibrated on the tight layout: ~1230
  // words fills two pages; below ~1050 page 2 is visibly sparse regardless of
  // density. Leaner (CoS-style) resumes can render full at ~1080-1100 words, so
  // the hard floor sits at 1050 and the visual probe refines from there.
  const wordCount = md.split(/\s+/).filter((w) => /\w/.test(w)).length;
  const fullCareerResume = gen.resume.experience.length >= 4; // skip gate for short/test fixtures
  if (fullCareerResume && wordCount < 1050) {
    throw new Error(
      `Resume too short for the two-page layout: ${wordCount} words (needs ~1200-1300). ` +
        `Do not pad with filler: restore more of the knowledge base's curated achievement bullets ` +
        `(second bullets for later roles are usually what got over-trimmed).`,
    );
  }
  if (fullCareerResume && wordCount < 1200)
    warnings.push(`length: ${wordCount} words — page 2 may run light (target 1200-1300)`);

  // ATS coverage vs the captured ad — advisory, surfaced to the caller. The
  // docx headline is part of what a parser sees, so it counts toward coverage.
  const snapshot = (await readSnapshot(store, appId)) ?? "";
  const ats = checkAtsCoverage(snapshot, `${md}\n${opts.headline ?? ""}`);
  if (ats.coverage < 0.6) {
    warnings.push(
      `ATS coverage ${(ats.coverage * 100).toFixed(0)}% — missing JD terms: ${ats.missing.slice(0, 8).join(", ")}`,
    );
  }

  // Persist the three artifacts together so they can never desync.
  await store.writeJson(["applications", appId, "resume.json"], gen);
  await saveResumeSource(store, appId, md);
  const docx = await markdownResumeToDocx(md, {
    ...(opts.headline ? { headline: opts.headline } : {}),
    ...(opts.template ? { template: opts.template } : {}),
  });
  await store.writeBinary(
    ["applications", appId, "resume.docx"],
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  await updateMeta(store, appId, { status: "drafted" });

  return { warnings, ats, style, provenanceEntries: gen.provenance_audit.length };
}
