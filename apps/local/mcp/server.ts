/**
 * Kairos MCP server (v0). The backend Claude Code drives.
 *
 * Design: this server is DATA + DETERMINISM only. It never calls a model. The
 * reasoning (extract / score / generate) is done by the host (Claude Code),
 * guided by the `/kairos` skill. Evidence tools return { system_prompt,
 * user_message } assembled from lib/prompts — the single source of truth — so the
 * skill and server never drift, and the anti-fabrication strip (stripUnverified)
 * runs in code before any evidence reaches the model.
 *
 * Storage is local files under ~/Kairos/ (see lib/store). Launched over stdio.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import matter from "gray-matter";

import { getStore, kairosHome } from "@/store";
import type { Store } from "@/store";
import {
  loadExperiences,
  loadEducation,
  loadVoiceProfile,
  loadSummaryBlocks,
  loadRecruiterFeedback,
  saveVoiceProfile,
  saveExperience,
  regenerateIndexMap,
} from "@kairos/engine/kb/store";
import {
  createApplication,
  loadIndex,
  readMeta,
  updateMeta,
  readSnapshot,
  readScoreReport,
  readResumeSource,
} from "@kairos/engine/applications";
import { saveScoredReport, saveGeneratedResume } from "@kairos/engine/tools/ops";
import { fetchJobAd, ingestPastedText } from "@kairos/engine/ingest";
import { fetchGreenhouseForm, formSummary, isWritingQuestion, saveApplicationForm } from "@kairos/engine/forms";
import {
  deriveSearchProfile,
  describeSearchProfile,
  loadSearchProfile,
  saveSearchProfile,
  type CandidateProfileFrontmatter,
  type StoredSearchProfile,
} from "@kairos/engine/sourcing/search-profile";
import { searchQA, upsertQA, readQA, loadQAIndex } from "@kairos/engine/qabank";
import { INSIGHTS_SYSTEM_PROMPT, buildInsightsUserMessage } from "@kairos/engine/prompts/insights";
import { ENRICHMENT_SYSTEM_PROMPT, buildEnrichmentUserMessage } from "@kairos/engine/prompts/enrichment";
import { serializeExperience, insertUnderSection } from "@kairos/engine/kb/experience";
import { computeHealth } from "@kairos/engine/health";
import {
  SCORING_SYSTEM_PROMPT,
  buildScoringUserMessage,
} from "@kairos/engine/prompts/scoring";
import {
  GENERATION_SYSTEM_PROMPT,
  buildGenerationUserMessage,
} from "@kairos/engine/prompts/generation";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
} from "@kairos/engine/prompts/extraction";
import {
  COVER_LETTER_SYSTEM_PROMPT,
  buildCoverLetterUserMessage,
} from "@kairos/engine/prompts/cover-letter";
import { generatedResumeToMarkdown, markdownResumeToHtml } from "@kairos/engine/resume-render";
import { markdownResumeToDocx, markdownLetterToDocx } from "@kairos/engine/docx-render";
import { htmlToPdf } from "@/lib/pdf";
import type { GeneratedResume } from "@kairos/engine/types";
import type { ScoreReport } from "@kairos/engine/types";

const store: Store = getStore();

// --- result helpers ---------------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wrap a handler so a thrown error becomes an isError result, never a crash. */
function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(msg(e));
    }
  };
}

/** Read the readable ad text out of a snapshot (drop the frontmatter). */
function snapshotText(snapshot: string | null): string {
  if (!snapshot) return "";
  try {
    return matter(snapshot).content.trim();
  } catch {
    return snapshot.trim();
  }
}

async function readProfile(): Promise<Record<string, unknown>> {
  const raw = await store.readFile(["profile.md"]);
  if (!raw) return {};
  try {
    return matter(raw).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = new McpServer({ name: "kairos", version: "0.1.0" });

// ============================================================================
// READ / CONTEXT
// ============================================================================

server.registerTool(
  "list_experiences",
  {
    title: "List knowledge-base experiences",
    description:
      "Summaries of every experience file in the knowledge base (company, title, dates, domains). Use to orient before scoring/generation.",
    inputSchema: {},
  },
  guard(async () => {
    const experiences = await loadExperiences(store);
    return ok(
      experiences.map((e) => ({
        fileName: e.fileName,
        company: e.frontmatter.company,
        title: e.frontmatter.title,
        dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
        domains: e.frontmatter.domains ?? [],
      })),
    );
  }),
);

server.registerTool(
  "read_experience",
  {
    title: "Read one knowledge-base experience",
    description:
      "The full markdown (frontmatter + body, provenance tags intact) of a single experience file. Use after list_experiences when you need the detail.",
    inputSchema: { fileName: z.string().describe("e.g. 02-amazon-genai-alexa-international.md") },
  },
  guard(async ({ fileName }) => {
    const experiences = await loadExperiences(store);
    const exp = experiences.find((e) => e.fileName === fileName || e.fileName === `${fileName}.md`);
    if (!exp) return fail(`Experience not found: ${fileName}`);
    return ok({ fileName: exp.fileName, markdown: serializeExperience(exp) });
  }),
);

server.registerTool(
  "list_applications",
  {
    title: "List applications",
    description: "The cross-application dashboard index (id, company, role, status, band).",
    inputSchema: {},
  },
  guard(async () => ok((await loadIndex(store)).applications)),
);

server.registerTool(
  "read_application",
  {
    title: "Read one application",
    description:
      "Full state for one application: meta, score report (if any), the job-ad text, and whether a resume draft exists.",
    inputSchema: { appId: z.string().describe("Application folder id, e.g. 2026-07-06_stripe_staff-pm") },
  },
  guard(async ({ appId }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    const [report, snapshot, resume] = await Promise.all([
      readScoreReport<ScoreReport>(store, appId),
      readSnapshot(store, appId),
      readResumeSource(store, appId),
    ]);
    return ok({ meta, score_report: report, job_text: snapshotText(snapshot), has_resume: Boolean(resume) });
  }),
);

// ============================================================================
// MEMORY (Session Brief, Q&A bank, insights)
// ============================================================================

server.registerTool(
  "load_context",
  {
    title: "Load the Session Brief",
    description:
      "Call this FIRST every session. Returns a compact digest so you start warm: profile, knowledge-base map, voice summary, distilled insights, Q&A bank index, and recent applications. Load full items on demand (read_experience, read_qa, read_application).",
    inputSchema: {},
  },
  guard(async () => {
    const [experiences, voice, insights, qaIndex, index, profile] = await Promise.all([
      loadExperiences(store),
      loadVoiceProfile(store),
      store.readFile(["insights.md"]),
      loadQAIndex(store),
      loadIndex(store),
      readProfile(),
    ]);
    return ok({
      profile,
      kb_map: experiences.map((e) => ({
        file: e.fileName,
        company: e.frontmatter.company,
        title: e.frontmatter.title,
        dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
        domains: e.frontmatter.domains ?? [],
        top_skills: (e.frontmatter.skills ?? []).slice(0, 5).map((s) => s.name),
      })),
      voice_summary: voice ? voice.slice(0, 700) : null,
      insights: insights ?? null,
      qa_index: qaIndex.entries.map((e) => ({ canonical_question: e.canonical_question, topics: e.topics, updated_at: e.updated_at })),
      recent_applications: index.applications.slice(0, 8),
    });
  }),
);

server.registerTool(
  "search_qa_bank",
  {
    title: "Search the Q&A bank",
    description:
      "Given an application question, find prior answers to reuse/adapt (ranked by overlap). Use this before answering any application question so answers compound instead of being rewritten.",
    inputSchema: { question: z.string() },
  },
  guard(async ({ question }) => ok(await searchQA(store, question))),
);

server.registerTool(
  "read_qa",
  {
    title: "Read a Q&A bank entry",
    description: "Full stored answer by slug.",
    inputSchema: { slug: z.string() },
  },
  guard(async ({ slug }) => {
    const e = await readQA(store, slug);
    return e ? ok(e) : fail(`Q&A entry not found: ${slug}`);
  }),
);

server.registerTool(
  "save_qa",
  {
    title: "Save an application answer",
    description:
      "Persist an answer to an application's question: appends to the application's questions.json AND upserts the Q&A bank for reuse on future applications.",
    inputSchema: {
      appId: z.string(),
      question: z.string(),
      answer: z.string(),
      topics: z.array(z.string()).optional().describe("Short topic tags for reuse matching, e.g. ['motivation','company-fit']"),
    },
  },
  guard(async ({ appId, question, answer, topics }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    const path = ["applications", appId, "questions.json"];
    const existing = (await store.readJson<{ question: string; answer: string }[]>(path)) ?? [];
    const i = existing.findIndex((q) => q.question === question);
    if (i === -1) existing.push({ question, answer });
    else existing[i] = { question, answer };
    await store.writeJson(path, existing);
    await upsertQA(store, { canonical_question: question, answer, topics, source_app: appId, at: new Date().toISOString() });
    return ok({ ok: true, appId, savedToBank: true });
  }),
);

server.registerTool(
  "get_insights_evidence",
  {
    title: "Get insights-synthesis evidence",
    description:
      "Assemble the data to refresh the candidate's insights memo (KB map + application history + prior insights + recruiter feedback). Returns { system_prompt, user_message }. Follow it, then call save_insights.",
    inputSchema: {},
  },
  guard(async () => {
    const [experiences, index, prior, feedback, profile] = await Promise.all([
      loadExperiences(store),
      loadIndex(store),
      store.readFile(["insights.md"]),
      loadRecruiterFeedback(store),
      readProfile(),
    ]);
    const user_message = buildInsightsUserMessage({
      profile,
      kbMap: experiences.map((e) => ({ company: e.frontmatter.company, title: e.frontmatter.title, domains: e.frontmatter.domains ?? [] })),
      applications: index.applications,
      priorInsights: prior,
      recruiterFeedback: feedback,
    });
    return ok({ system_prompt: INSIGHTS_SYSTEM_PROMPT, user_message });
  }),
);

server.registerTool(
  "save_insights",
  {
    title: "Save the insights memo",
    description: "Persist the distilled insights markdown to insights.md.",
    inputSchema: { markdown: z.string() },
  },
  guard(async ({ markdown }) => {
    await store.writeFile(["insights.md"], markdown);
    return ok({ ok: true, saved: "insights.md" });
  }),
);

// ============================================================================
// ONBOARDING (resume -> knowledge base)
// ============================================================================

server.registerTool(
  "prepare_extraction",
  {
    title: "Prepare resume extraction",
    description:
      "Read an uploaded resume PDF and return the extraction system prompt + user message. YOU then produce the ExtractionResult JSON and persist it with save_experience / save_education / save_voice_profile / save_profile.",
    inputSchema: { pdf_path: z.string().describe("Absolute path to the resume PDF on disk") },
  },
  guard(async ({ pdf_path }) => {
    const { readFile } = await import("node:fs/promises");
    const buffer = new Uint8Array(await readFile(pdf_path));
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: true });
    const resumeText = Array.isArray(text) ? text.join("\n") : text;
    if (!resumeText || resumeText.trim().length < 100) {
      return fail("The PDF had almost no extractable text (may be a scanned image).");
    }
    return ok({
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
      user_message: buildExtractionUserMessage(resumeText),
      chars: resumeText.length,
    });
  }),
);

server.registerTool(
  "resume_health_check",
  {
    title: "Résumé health check",
    description:
      "Job-agnostic quality report on the knowledge base: quantification, weak/vague bullets, action verbs, AI tells, provenance depth, and mechanics. Deterministic and evidence-linked. Run this after onboarding to give the user immediate, concrete next steps (and route them into enrichment).",
    inputSchema: {},
  },
  guard(async () => {
    const [experiences, profile] = await Promise.all([loadExperiences(store), readProfile()]);
    return ok(
      computeHealth(experiences, {
        contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
        headline: typeof profile.headline === "string" ? profile.headline : undefined,
      }),
    );
  }),
);

server.registerTool(
  "get_enrichment_questions",
  {
    title: "Get enrichment interview questions",
    description:
      "Deepen the knowledge base beyond the résumé. Given an experience file, returns { system_prompt, user_message } to interview the candidate for the context, deeper detail, stories (STAR), and skills the résumé compressed away. Follow it, ask the questions conversationally, then store each answer with save_confirmed_fact.",
    inputSchema: { fileName: z.string().describe("Experience to deepen, e.g. 02-amazon-genai-alexa-international.md") },
  },
  guard(async ({ fileName }) => {
    const experiences = await loadExperiences(store);
    const exp = experiences.find((e) => e.fileName === fileName);
    if (!exp) return fail(`Experience not found: ${fileName}`);
    const profile = await readProfile();
    const targetRoles = Array.isArray(profile.target_roles) ? (profile.target_roles as string[]) : [];
    // DELIBERATE exception to the stripUnverified rule: enrichment is the one
    // path that sends [?] facts (and the raw-material pen) to the model, because
    // its whole job is interviewing the candidate to confirm them into [C].
    // The enrichment system prompt produces QUESTIONS only, never facts.
    const user_message = buildEnrichmentUserMessage({
      experienceMarkdown: serializeExperience(exp),
      targetRoles,
    });
    return ok({ system_prompt: ENRICHMENT_SYSTEM_PROMPT, user_message });
  }),
);

server.registerTool(
  "save_confirmed_fact",
  {
    title: "Save a user-confirmed fact",
    description:
      "Store one fact the candidate actually told you, into an experience under a section, tagged [C] (confirmed). Use during enrichment or when a job's clarifying question surfaces a real fact. NEVER call this with anything the candidate did not confirm.",
    inputSchema: {
      fileName: z.string(),
      section: z
        .string()
        .describe("Section heading: 'Context & mandate', 'Deeper detail', 'Stories', or 'Skills note'"),
      content: z.string().describe("The fact/story as a markdown bullet or short paragraph, in the candidate's words"),
    },
  },
  guard(async ({ fileName, section, content }) => {
    const experiences = await loadExperiences(store);
    const exp = experiences.find((e) => e.fileName === fileName);
    if (!exp) return fail(`Experience not found: ${fileName}`);
    exp.body = insertUnderSection(exp.body, section, content);
    await saveExperience(store, exp);
    return ok({ ok: true, fileName, section, tagged: "[C]" });
  }),
);

server.registerTool(
  "save_experience",
  {
    title: "Save an experience file",
    description:
      "Persist one knowledge-base experience (frontmatter + provenance-tagged markdown body). Every fact must carry [R]/[C]/[F]; [?] notes are allowed only in a 'Raw material / notes' holding pen.",
    inputSchema: {
      fileName: z.string().describe("e.g. 01-stripe-staff-pm.md"),
      frontmatter: z.record(z.string(), z.any()).describe("Experience frontmatter object"),
      body: z.string().describe("Markdown body with provenance-tagged bullets"),
    },
  },
  guard(async ({ fileName, frontmatter, body }) => {
    if (!fileName.endsWith(".md")) return fail("fileName must end with .md");
    await saveExperience(store, {
      fileName,
      frontmatter: frontmatter as never,
      body,
    });
    return ok({ ok: true, saved: `knowledge-base/experiences/${fileName}` });
  }),
);

server.registerTool(
  "save_education",
  {
    title: "Save an education file",
    description: "Persist one education entry (frontmatter + body).",
    inputSchema: {
      fileName: z.string(),
      frontmatter: z.record(z.string(), z.any()),
      body: z.string(),
    },
  },
  guard(async ({ fileName, frontmatter, body }) => {
    if (!fileName.endsWith(".md")) return fail("fileName must end with .md");
    await store.writeFile(
      ["knowledge-base", "education", fileName],
      matter.stringify(`\n${body}\n`, frontmatter as Record<string, unknown>),
    );
    return ok({ ok: true, saved: `knowledge-base/education/${fileName}` });
  }),
);

server.registerTool(
  "save_voice_profile",
  {
    title: "Save the voice profile",
    description: "Persist the learned writing-style profile (markdown).",
    inputSchema: { markdown: z.string() },
  },
  guard(async ({ markdown }) => {
    await saveVoiceProfile(store, markdown);
    return ok({ ok: true, saved: "knowledge-base/_voice-profile.md" });
  }),
);

server.registerTool(
  "save_profile",
  {
    title: "Save the candidate profile",
    description:
      "Persist identity + targeting: name, contact_line, target_roles, target_seniority, domains, preferences, deal_breakers.",
    inputSchema: {
      name: z.string().optional(),
      contact_line: z.string().optional(),
      headline: z.string().optional().describe("Tagline under the name, e.g. 'AI Technical Product Leader'"),
      target_roles: z.array(z.string()).optional(),
      target_seniority: z.string().optional(),
      domains: z.array(z.string()).optional(),
      preferences: z.record(z.string(), z.any()).optional(),
      deal_breakers: z.array(z.string()).optional(),
    },
  },
  guard(async (fields) => {
    const existing = await readProfile();
    const merged = { ...existing, ...clean(fields) };
    const body =
      "# Candidate profile\n\nIdentity and targeting used to prioritize roles and ground generation.\n";
    await store.writeFile(["profile.md"], matter.stringify(body, merged));
    return ok({ ok: true, saved: "profile.md", profile: merged });
  }),
);

server.registerTool(
  "rebuild_index",
  {
    title: "Rebuild the KB index map",
    description: "Regenerate knowledge-base/_index.md from all experiences. Call after saving experiences.",
    inputSchema: {},
  },
  guard(async () => {
    await regenerateIndexMap(store);
    return ok({ ok: true, rebuilt: "knowledge-base/_index.md" });
  }),
);

// ============================================================================
// SOURCING PREFERENCES (per-user search profile — never constants in code)
// ============================================================================

server.registerTool(
  "get_search_profile",
  {
    title: "Get the sourcing search profile",
    description:
      "Read the user's sourcing preferences (sourcing/search-profile.json). If none exists yet, derives a starting profile from profile.md and stores it marked 'derived'. Use this to open a preferences conversation: summarize the returned description in plain language, then adjust via save_search_profile as the user confirms changes.",
    inputSchema: {},
  },
  guard(async () => {
    let profile = await loadSearchProfile(store);
    if (!profile) {
      const fm = (await readProfile()) as CandidateProfileFrontmatter;
      profile = deriveSearchProfile(fm);
      await saveSearchProfile(store, profile);
    }
    return ok({ profile, description: describeSearchProfile(profile) });
  }),
);

server.registerTool(
  "save_search_profile",
  {
    title: "Save the sourcing search profile",
    description:
      "Persist the user's sourcing preferences after they confirm changes in conversation. Pass the COMPLETE profile (all fields). Set source to 'confirmed' once the user has engaged with the preferences. Never save invented preferences.",
    inputSchema: {
      function_terms: z.array(z.string()).describe("Title words that gate the discipline (hard filter)"),
      exclude_terms: z.array(z.string()),
      locations: z.array(z.string()).describe("Place words that count as local; lowercase"),
      secondary_locations: z.array(z.string()).optional().describe("Higher-bar places: only strong fits surface; may include international cities"),
      boost_terms: z.array(z.string()),
      seniority_terms: z.array(z.string()),
      max_age_days: z.number().int().min(1).max(60),
      international_ok: z.boolean().optional(),
      notes: z.string().optional(),
      source: z.enum(["derived", "confirmed"]),
    },
  },
  guard(async (fields) => {
    const profile: StoredSearchProfile = {
      ...fields,
      updated_at: new Date().toISOString(),
    } as StoredSearchProfile;
    await saveSearchProfile(store, profile);
    return ok({ ok: true, saved: "sourcing/search-profile.json", description: describeSearchProfile(profile) });
  }),
);

// ============================================================================
// JOB CAPTURE (§26 — snapshot first)
// ============================================================================

server.registerTool(
  "capture_job_ad",
  {
    title: "Capture a job ad",
    description:
      "Snapshot a job ad to storage FIRST (§26), before any scoring. Provide a URL (fetched server-side) or the pasted text, plus the company and role (you read these from the ad). Returns the appId and the job text.",
    inputSchema: {
      company: z.string(),
      role: z.string(),
      url: z.string().optional().describe("Job posting URL (best-effort fetch). ALWAYS pass it, including alongside pasted text — it becomes the card's link."),
      text: z.string().optional().describe("Pasted ad text (use when no URL or fetch fails)"),
      no_url: z.boolean().optional().describe("Set true ONLY when the ad genuinely has no public URL (e.g. an emailed JD). Without it, captures missing a url are rejected."),
    },
  },
  guard(async ({ company, role, url, text, no_url }) => {
    if (!url && !text) return fail("Provide either a url or the pasted text.");
    if (!url && !no_url)
      return fail(
        "Pasted-text capture without a url: pass the posting URL too (it becomes the card's link), or set no_url: true if the ad truly has no public URL.",
      );
    let ad;
    if (text && text.trim().length > 0) {
      ad = ingestPastedText(text, { company, title: role, source_url: url });
    } else {
      try {
        ad = await fetchJobAd(url!);
      } catch (e) {
        return fail(`Could not fetch the URL (${msg(e)}). Paste the ad text into the 'text' field instead.`);
      }
    }
    const meta = await createApplication(store, {
      company,
      role,
      snapshotMarkdown: ad.markdown,
      source_url: url,
      source_url_unavailable: no_url,
    });
    // Best-effort form harvest (Greenhouse only): know every question the
    // application will ask BEFORE tailoring, so answers get drafted up front.
    let form_questions: string[] | undefined;
    if (url) {
      const form = await fetchGreenhouseForm(url);
      if (form) {
        await saveApplicationForm(store, meta.id, form);
        form_questions = form.questions.filter(isWritingQuestion).map((q) => q.label);
      }
    }
    return ok({ appId: meta.id, company, role, job_text: ad.text, form_questions });
  }),
);

server.registerTool(
  "fetch_application_form",
  {
    title: "Fetch the application form questions",
    description:
      "Fetch the actual application-form question schema for an application (Greenhouse boards only) and store it as application-form.json. Use to backfill an existing application or refresh a stale form. Then draft answers for the custom text/essay questions (qa-bank first via search_qa_bank) and save them with save_qa / the questions.json convention for review.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    if (!meta.source_url) return fail("Application has no source_url to fetch the form from.");
    const form = await fetchGreenhouseForm(meta.source_url);
    if (!form) {
      return fail(
        "No form schema available: the URL is not a public Greenhouse board posting (or the fetch failed).",
      );
    }
    await saveApplicationForm(store, appId, form);
    return ok({ appId, summary: formSummary(form), questions: form.questions });
  }),
);

// ============================================================================
// SCORING
// ============================================================================

server.registerTool(
  "get_scoring_evidence",
  {
    title: "Get scoring evidence",
    description:
      "Assemble the scoring payload for an application: job text + your knowledge base with ALL unverified [?] facts stripped in code. Returns { system_prompt, user_message }. Follow the system prompt, produce the ScoreReport JSON, then call save_score.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    const [experiences, educationRaw, voiceProfile, recruiterFeedback, snapshot] = await Promise.all([
      loadExperiences(store),
      loadEducation(store),
      loadVoiceProfile(store),
      loadRecruiterFeedback(store),
      readSnapshot(store, appId),
    ]);
    if (experiences.length === 0) {
      return fail("No experiences in the knowledge base yet. Run onboarding first.");
    }
    const user_message = buildScoringUserMessage({
      jobText: snapshotText(snapshot),
      detectedAts: meta.detected_ats ?? "unknown",
      sourceUrl: meta.source_url,
      experiences,
      educationRaw,
      voiceProfile,
      recruiterFeedback,
      mode: "audit",
    });
    return ok({ system_prompt: SCORING_SYSTEM_PROMPT, user_message });
  }),
);

server.registerTool(
  "save_score",
  {
    title: "Save a score report",
    description:
      "Persist the ScoreReport JSON you produced for an application. Updates status to 'scored' and records the band + recommendation.",
    inputSchema: {
      appId: z.string(),
      report: z.record(z.string(), z.any()).describe("The full ScoreReport JSON"),
      label: z
        .string()
        .optional()
        .describe("Version label, e.g. 'Default résumé' (untailored baseline) or 'Optimized résumé' (after tailoring). Enables the before/after comparison."),
    },
  },
  guard(async ({ appId, report, label }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    // The guarded op validates the full ScoreReport shape (zod) and does the
    // status/band bookkeeping; an invalid report throws with actionable issues.
    const r = report as unknown as ScoreReport;
    await saveScoredReport(store, appId, label ?? "Score", r);
    return ok({ ok: true, appId, label: label ?? "Score", band: r.match.overall_band, recommendation: r.recommendation });
  }),
);

// ============================================================================
// GENERATION
// ============================================================================

server.registerTool(
  "get_generation_evidence",
  {
    title: "Get generation evidence",
    description:
      "Assemble the generation payload for an application: the score report + your knowledge base with unverified [?] facts stripped in code + voice profile + candidate identity. Returns { system_prompt, user_message }. Follow the system prompt, produce the GeneratedResume JSON, then call save_resume.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    const report = await readScoreReport<ScoreReport>(store, appId);
    if (!report) return fail("No score report yet — call get_scoring_evidence and save_score first.");
    const [experiences, educationRaw, voiceProfile, summaryBlocks, recruiterFeedback, snapshot, profile, referenceResume] =
      await Promise.all([
        loadExperiences(store),
        loadEducation(store),
        loadVoiceProfile(store),
        loadSummaryBlocks(store),
        loadRecruiterFeedback(store),
        readSnapshot(store, appId),
        readProfile(),
        store.readFile(["knowledge-base", "reference-resume.md"]),
      ]);
    const user_message = buildGenerationUserMessage({
      referenceResume,
      jobText: snapshotText(snapshot),
      detectedAts: meta.detected_ats ?? "unknown",
      company: meta.company,
      title: meta.role,
      scoreReport: report,
      experiences,
      educationRaw,
      voiceProfile,
      summaryBlocks,
      recruiterFeedback,
      candidateName: typeof profile.name === "string" ? profile.name : undefined,
      contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
    });
    return ok({ system_prompt: GENERATION_SYSTEM_PROMPT, user_message });
  }),
);

server.registerTool(
  "save_resume",
  {
    title: "Save a generated resume",
    description:
      "Persist the GeneratedResume JSON you produced. Writes the structured resume (with provenance_audit) and an editable markdown source. Updates status to 'drafted'.",
    inputSchema: {
      appId: z.string(),
      resume: z.record(z.string(), z.any()).describe("The full GeneratedResume JSON (incl. provenance_audit)"),
      headline: z.string().optional().describe("Headline shown next to the name in the .docx, e.g. 'AI Product Builder'"),
    },
  },
  guard(async ({ appId, resume, headline }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    // The guarded op enforces everything: zod shape, mechanical grounding
    // against the [?]-stripped KB (employers/metrics/provenance sources),
    // house-style hard rules, and writes json+md+docx together. On violation it
    // throws with the exact findings — fix the resume and call again.
    const result = await saveGeneratedResume(store, appId, resume as unknown as GeneratedResume, { headline });
    // Keep a submit-ready PDF next to the editable docx (best-effort; no-op if
    // LibreOffice is absent). The docx stays the master for quick manual tuning.
    const { renderDocxToPdf } = await import("@/lib/pdf-render");
    const pdf = await renderDocxToPdf(`${kairosHome()}/applications/${appId}/resume.docx`);
    return ok({
      ok: true,
      appId,
      pdf_rendered: !!pdf,
      provenance_audit_entries: result.provenanceEntries,
      ats_coverage: `${(result.ats.coverage * 100).toFixed(0)}%`,
      ats_missing_terms: result.ats.missing.slice(0, 10),
      warnings: result.warnings,
      dropped_for_relevance: (resume as unknown as GeneratedResume).dropped_for_relevance ?? [],
    });
  }),
);

server.registerTool(
  "get_cover_letter_evidence",
  {
    title: "Get cover-letter evidence",
    description:
      "Assemble the cover-letter payload for an application: job text + your knowledge base (unverified [?] facts stripped in code) + voice profile + the score's strengths and honest gap. Returns { system_prompt, user_message }. The system prompt is a dedicated human-voice engine with hard anti-AI-tell rules — follow it exactly, produce the plain-prose letter, then call save_cover_letter.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    const [experiences, voiceProfile, snapshot, report, profile] = await Promise.all([
      loadExperiences(store),
      loadVoiceProfile(store),
      readSnapshot(store, appId),
      readScoreReport<ScoreReport>(store, appId),
      readProfile(),
    ]);
    const honestGap = report?.gaps?.find((g) => g.type === "genuine_gap")?.requirement ?? null;
    const keyStrengths = report?.authenticity?.strengths ?? [];
    const user_message = buildCoverLetterUserMessage({
      jobText: snapshotText(snapshot),
      company: meta.company,
      title: meta.role,
      experiences,
      voiceProfile,
      candidateName: typeof profile.name === "string" ? profile.name : undefined,
      contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
      keyStrengths,
      honestGap,
      whyCompany: typeof profile.why_company === "string" ? profile.why_company : null,
      date: new Date().toISOString().slice(0, 10),
    });
    return ok({ system_prompt: COVER_LETTER_SYSTEM_PROMPT, user_message });
  }),
);

server.registerTool(
  "save_cover_letter",
  {
    title: "Save a cover letter",
    description:
      "Persist the plain-prose cover letter (markdown) you wrote. Writes cover-letter.md and a business-letter cover-letter.docx.",
    inputSchema: { appId: z.string(), markdown: z.string() },
  },
  guard(async ({ appId, markdown }) => {
    const meta = await readMeta(store, appId);
    if (!meta) return fail(`Application not found: ${appId}`);
    await store.writeFile(["applications", appId, "cover-letter.md"], markdown);
    const docx = await markdownLetterToDocx(markdown);
    await store.writeBinary(
      ["applications", appId, "cover-letter.docx"],
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const { renderDocxToPdf } = await import("@/lib/pdf-render");
    const pdf = await renderDocxToPdf(`${kairosHome()}/applications/${appId}/cover-letter.docx`);
    return ok({ ok: true, saved: `applications/${appId}/cover-letter.md (+ .docx${pdf ? " + .pdf" : ""})` });
  }),
);

server.registerTool(
  "check_resume_layout",
  {
    title: "Check the rendered resume's page layout",
    description:
      "Visually measure the saved resume.docx (renders to PDF, counts pages and last-page fill). Returns verdict 'good' | 'short' | 'overflow' with actionable guidance. Call after save_resume/render_docx to confirm the resume fills its pages without spilling. Requires LibreOffice locally; returns available:false if not installed (then rely on the word-count gate).",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const { probeResumeLayout } = await import("../lib/layout-probe");
    const docxPath = `${kairosHome()}/applications/${appId}/resume.docx`;
    const layout = await probeResumeLayout(docxPath);
    if (!layout) return ok({ available: false, note: "Layout probe unavailable (LibreOffice/poppler not found); rely on the word-count gate." });
    return ok({ available: true, ...layout });
  }),
);

server.registerTool(
  "render_docx",
  {
    title: "Render the resume to Word (.docx)",
    description:
      "PRIMARY export. Render the application's editable resume markdown to a clean, ATS-safe, editable .docx at applications/<appId>/resume.docx — sans-serif, single column, tight one-page density, with bold bullet lead-ins and the candidate's headline. Requires a saved resume.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const md = await readResumeSource(store, appId);
    if (!md) return fail("No resume to render — call save_resume first.");
    const profile = await readProfile();
    const headline = typeof profile.headline === "string" ? profile.headline : undefined;
    const docx = await markdownResumeToDocx(md, { headline });
    const path = await store.writeBinary(
      ["applications", appId, "resume.docx"],
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // Keep the submit-ready PDF in lockstep with the docx (best-effort).
    const { renderDocxToPdf } = await import("@/lib/pdf-render");
    const pdf = await renderDocxToPdf(`${kairosHome()}/applications/${appId}/resume.docx`);
    return ok({ ok: true, docxPath: path, pdf_rendered: !!pdf });
  }),
);

server.registerTool(
  "render_pdf",
  {
    title: "Render the resume to PDF",
    description:
      "Render the application's resume to applications/<appId>/resume.pdf. Prefers a faithful LibreOffice render of resume.docx (identical layout — Calibri, spacing, page breaks — to the editable docx the user reviews), and falls back to the text-based HTML template PDF when LibreOffice is absent. Requires a saved resume.",
    inputSchema: { appId: z.string() },
  },
  guard(async ({ appId }) => {
    const md = await readResumeSource(store, appId);
    if (!md) return fail("No resume to render — call save_resume first.");
    // Faithful path: render the actual docx so the PDF matches what the user
    // edits and reviews. Only fall back to the HTML template if LibreOffice is
    // unavailable, so the two artifacts don't diverge in design.
    const { renderDocxToPdf } = await import("@/lib/pdf-render");
    const docxPath = `${kairosHome()}/applications/${appId}/resume.docx`;
    const faithful = await renderDocxToPdf(docxPath);
    if (faithful) return ok({ ok: true, pdfPath: faithful, source: "docx" });
    const pdf = await htmlToPdf(markdownResumeToHtml(md));
    const path = await store.writeBinary(["applications", appId, "resume.pdf"], pdf, "application/pdf");
    return ok({ ok: true, pdfPath: path, source: "html-template" });
  }),
);

// --- utils ------------------------------------------------------------------
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// --- boot -------------------------------------------------------------------
async function main() {
  // stderr only — stdout is reserved for the MCP protocol.
  console.error(`[kairos-mcp] storage root: ${kairosHome()}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[kairos-mcp] ready");
}

main().catch((e) => {
  console.error("[kairos-mcp] fatal:", e);
  process.exit(1);
});
