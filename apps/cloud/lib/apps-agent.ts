import Anthropic from "@anthropic-ai/sdk";
import { TASK_MODELS } from "./models";
import type { DriveStore } from "../store/drive";
import { readMeta, readSnapshot, readScoreReport } from "@kairos/engine/applications";
import {
  loadExperiences,
  loadEducation,
  loadVoiceProfile,
  loadSummaryBlocks,
  loadRecruiterFeedback,
} from "@kairos/engine/kb/store";
import { SCORING_SYSTEM_PROMPT, buildScoringUserMessage } from "@kairos/engine/prompts/scoring";
import {
  GENERATION_SYSTEM_PROMPT,
  buildGenerationUserMessage,
} from "@kairos/engine/prompts/generation";
import { resumeLengthPolicy } from "@kairos/engine/length-policy";
import { generatedResumeToMarkdown } from "@kairos/engine/resume-render";
import {
  COVER_LETTER_SYSTEM_PROMPT,
  buildCoverLetterUserMessage,
} from "@kairos/engine/prompts/cover-letter";
import { markdownLetterToDocx } from "@kairos/engine/docx-render";
import { checkStyle, isHardStyleViolation } from "@kairos/engine/tools/checks";
import { saveScoredReport, saveGeneratedResume } from "@kairos/engine/tools/ops";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";
import type { TemplateSpec } from "@kairos/engine/docx-render";
import { ClaudeUserError, parseJsonBlock, toUserError } from "./claude";

/**
 * Scoring + generation for the cloud lane — the same evidence assembly and the
 * same guarded save path as the local MCP tools, driven server-side on the
 * student's key. Quality is load-bearing here, so both run on Opus regardless
 * of the enrichment picker.
 */

const MODEL = TASK_MODELS.scoring.id;

async function callJson<T>(client: Anthropic, system: string, messages: Anthropic.MessageParam[]): Promise<{ parsed: T | null; raw: string }> {
  let message: Anthropic.Message;
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system,
      messages,
    });
    message = await stream.finalMessage();
  } catch (err) {
    toUserError(err);
  }
  if (message!.stop_reason === "refusal") {
    throw new ClaudeUserError("Claude declined this request. Is the pasted text really a job ad?");
  }
  const raw = message!.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { parsed: parseJsonBlock<T>(raw), raw };
}

export async function runScoringForApp(
  apiKey: string,
  store: DriveStore,
  appId: string,
): Promise<ScoreReport> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new ClaudeUserError("Application not found.");

  const [experiences, educationRaw, voiceProfile, recruiterFeedback, snapshot] = await Promise.all([
    loadExperiences(store),
    loadEducation(store),
    loadVoiceProfile(store),
    loadRecruiterFeedback(store),
    readSnapshot(store, appId),
  ]);
  if (experiences.length === 0) {
    throw new ClaudeUserError("Your knowledge base is empty. Upload your résumé first.");
  }

  const user_message = buildScoringUserMessage({
    jobText: snapshot ?? "",
    detectedAts: meta.detected_ats ?? "unknown",
    sourceUrl: meta.source_url,
    experiences,
    educationRaw,
    voiceProfile,
    recruiterFeedback,
    mode: "audit",
  });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user_message }];

  // One repair round: if the report fails the zod gate, feed the exact issues back.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { parsed, raw } = await callJson<ScoreReport>(client, SCORING_SYSTEM_PROMPT, messages);
    if (parsed) {
      try {
        await saveScoredReport(store, appId, "Score", parsed);
        return parsed;
      } catch (err) {
        if (attempt === 1) throw new ClaudeUserError("Scoring produced an invalid report twice. Try again.");
        messages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content: `That report failed validation: ${err instanceof Error ? err.message : String(err)}\nReturn the corrected FULL JSON only.`,
          },
        );
        continue;
      }
    }
    if (attempt === 1) throw new ClaudeUserError("Scoring did not return valid JSON. Try again.");
    messages.push(
      { role: "assistant", content: raw },
      { role: "user", content: "That was not valid JSON. Return ONLY the full ScoreReport JSON." },
    );
  }
  throw new ClaudeUserError("Scoring failed. Try again.");
}

export interface GenerationOutcome {
  atsCoverage: number;
  atsMissing: string[];
  warnings: string[];
  provenanceEntries: number;
}

/** Parse the identity block written at onboarding. */
function parseProfile(profileRaw: string): { name?: string; headline?: string; contact?: string } {
  const nameLine = profileRaw.split("\n").find((l) => l.startsWith("# "));
  const lines = profileRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("Source:"));
  const contact = lines.find((l) => l.includes("@"));
  const headline = lines[0] && lines[0] !== contact ? lines[0] : undefined;
  return { name: nameLine?.replace(/^#\s+/, "").trim(), headline, contact };
}

export async function runGenerationForApp(
  apiKey: string,
  store: DriveStore,
  appId: string,
): Promise<GenerationOutcome> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new ClaudeUserError("Application not found.");
  const report = await readScoreReport<ScoreReport>(store, appId);
  if (!report) throw new ClaudeUserError("Score this application first.");

  const [experiences, educationRaw, voiceProfile, summaryBlocks, recruiterFeedback, snapshot, profileRaw, templateSpec] =
    await Promise.all([
      loadExperiences(store),
      loadEducation(store),
      loadVoiceProfile(store),
      loadSummaryBlocks(store),
      loadRecruiterFeedback(store),
      readSnapshot(store, appId),
      store.readFile(["profile.md"]),
      store.readJson<{ overrides: Partial<TemplateSpec> }>(["templates", "template-spec.json"]),
    ]);

  const profile = parseProfile(profileRaw ?? "");
  const { targetPages } = resumeLengthPolicy(experiences);

  const user_message = buildGenerationUserMessage({
    jobText: snapshot ?? "",
    detectedAts: meta.detected_ats ?? "unknown",
    company: meta.company,
    title: meta.role,
    scoreReport: report,
    experiences,
    educationRaw,
    voiceProfile,
    summaryBlocks,
    recruiterFeedback,
    candidateName: profile.name,
    contactLine: profile.contact,
    targetPages,
  });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user_message }];

  // The guarded save (grounding + house style) may reject; give Claude the
  // exact findings and let it repair — same loop the local driver runs by hand.
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { parsed, raw } = await callJson<GeneratedResume>(client, GENERATION_SYSTEM_PROMPT, messages);
    if (!parsed) {
      lastError = "not valid JSON";
      messages.push(
        { role: "assistant", content: raw },
        { role: "user", content: "That was not valid JSON. Return ONLY the full GeneratedResume JSON." },
      );
      continue;
    }
    // Mechanical length gate: the prompt asks for N pages, this measures it.
    // ~480 words/page holds for a dense single-column résumé at 10-11pt.
    const maxWords = targetPages === 1 ? 520 : 1000;
    const wordCount = generatedResumeToMarkdown(parsed).split(/\s+/).length;
    if (wordCount > maxWords) {
      lastError = `too long: ${wordCount} words for ${targetPages} page(s)`;
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `The résumé is ~${wordCount} words; it must fit ${targetPages} page(s), so cut to at most ${maxWords - 40} words. Trim the weakest bullets and condense the oldest roles to one line each. Keep the strongest metrics untouched. Return the corrected FULL JSON.`,
        },
      );
      continue;
    }

    try {
      const result = await saveGeneratedResume(store, appId, parsed, {
        headline: profile.headline,
        template: templateSpec?.overrides,
      });
      const outcome: GenerationOutcome = {
        atsCoverage: result.ats.coverage,
        atsMissing: result.ats.missing,
        warnings: result.warnings,
        provenanceEntries: result.provenanceEntries,
      };
      await store.writeJson(["applications", appId, "generation-report.json"], outcome);
      return outcome;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `The save was rejected by the anti-fabrication/style gate: ${lastError}\nFix ONLY what the findings name (never invent new facts to satisfy a check; drop the claim instead) and return the corrected FULL JSON.`,
        },
      );
    }
  }
  throw new ClaudeUserError(`Résumé generation failed the quality gate 3 times (${lastError.slice(0, 300)}). Try again.`);
}

/**
 * Cover letter (opt-in, per the product rule): plain-prose human-voice letter,
 * hard house-style gate with one repair round, written as .md + .docx together.
 */
export async function runCoverLetterForApp(
  apiKey: string,
  store: DriveStore,
  appId: string,
  opts: { whyCompany?: string | null } = {},
): Promise<void> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new ClaudeUserError("Application not found.");
  const report = await readScoreReport<ScoreReport>(store, appId);

  const [experiences, voiceProfile, snapshot, profileRaw] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store),
    readSnapshot(store, appId),
    store.readFile(["profile.md"]),
  ]);
  if (experiences.length === 0) {
    throw new ClaudeUserError("Your knowledge base is empty. Upload your résumé first.");
  }
  const profile = parseProfile(profileRaw ?? "");

  const user_message = buildCoverLetterUserMessage({
    jobText: snapshot ?? "",
    company: meta.company,
    title: meta.role,
    experiences,
    voiceProfile,
    candidateName: profile.name,
    contactLine: profile.contact,
    keyStrengths: report?.authenticity?.strengths ?? [],
    honestGap: report?.gaps?.find((g) => g.type === "genuine_gap")?.requirement ?? null,
    whyCompany: opts.whyCompany ?? null,
    date: new Date().toISOString().slice(0, 10),
  });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user_message }];

  let markdown = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        system: COVER_LETTER_SYSTEM_PROMPT,
        messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      toUserError(err);
    }
    markdown = message!.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!markdown) throw new ClaudeUserError("The letter came back empty. Try again.");

    const hard = checkStyle(markdown).filter(isHardStyleViolation);
    if (hard.length === 0) break;
    if (attempt === 1) {
      throw new ClaudeUserError(
        `The letter kept violating house style (${hard.map((v) => v.rule).join(", ")}). Try again.`,
      );
    }
    messages.push(
      { role: "assistant", content: markdown },
      {
        role: "user",
        content: `The letter violates the style rules: ${hard.map((v) => `${v.rule} (${v.detail})`).join("; ")}. Rewrite the FULL letter without these. Same facts only.`,
      },
    );
  }

  await store.writeFile(["applications", appId, "cover-letter.md"], markdown);
  const docx = await markdownLetterToDocx(markdown);
  await store.writeBinary(
    ["applications", appId, "cover-letter.docx"],
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
}
