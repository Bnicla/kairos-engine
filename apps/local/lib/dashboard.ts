import matter from "gray-matter";
import { marked } from "marked";
import { getStore } from "@/store";
import {
  loadIndexHealed,
  readMeta,
  readScoreReport,
  readScoreVersions,
  readSnapshot,
  readResumeSource,
  type IndexEntry,
  type ApplicationMeta,
  type ScoreVersion,
} from "@kairos/engine/applications";
import { loadExperiences, loadVoiceProfile } from "@kairos/engine/kb/store";
import { readApplicationForm, type ApplicationForm } from "@kairos/engine/forms";
import { computeHealth, type HealthReport } from "@kairos/engine/health";
import type { ScoreReport } from "@kairos/engine/types";

/**
 * Server-side read layer for the local dashboard. Everything comes from the same
 * ~/Kairos/ files the MCP server writes — the dashboard never mutates, it renders.
 */

/** Index entry + which documents exist (drives the Draft-card generate buttons). */
export type BoardEntry = IndexEntry & { has_resume?: boolean; has_cover_letter?: boolean };

export interface DashboardData {
  applications: BoardEntry[];
  experiences: { fileName: string; company: string; title: string; dates: string; domains: string[] }[];
  profile: { name?: string; headline?: string; contact_line?: string; target_roles?: string[] };
  insightsHtml: string | null;
  home: string;
}

export interface SourcedPosting {
  company: string;
  title: string;
  url: string;
  location: string;
  age_days: number | null;
  location_fit: "match" | "stretch";
  reasons: string[];
  guess_band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";
  one_liner?: string;
  /** Present only on `dropped`: why the role was cut before the board. */
  drop_reason?: "over_cap" | "triage_cut" | "same_company" | "below_cut";
  /** Set by Track/Dismiss actions on the last-run entry. */
  captured?: boolean;
  dismissed?: boolean;
}

export interface SourcedRun {
  ran_at: string;
  boards_swept: number;
  postings_fetched: number;
  /** Did the model triage run? false = deterministic UNRANKED fallback. */
  triaged?: boolean;
  /** Non-null when triage failed (e.g. expired CLI auth) — surface as a warning. */
  triage_error?: string | null;
  survivors: SourcedPosting[];
  stretch: SourcedPosting[];
  /** Prefilter survivors that did not reach the board (view-all page). */
  dropped?: SourcedPosting[];
}

/** Latest sourcing run for the Sourced column; null before the first run. */
export async function getSourcedRun(): Promise<SourcedRun | null> {
  const store = getStore();
  return store.readJson<SourcedRun>(["sourcing", "last-run.json"]);
}

export async function getDashboard(): Promise<DashboardData> {
  const store = getStore();
  const [index, experiences, profileRaw, insightsMd] = await Promise.all([
    loadIndexHealed(store),
    loadExperiences(store),
    store.readFile(["profile.md"]),
    store.readFile(["insights.md"]),
  ]);
  const profile = profileRaw ? (matter(profileRaw).data as DashboardData["profile"]) : {};
  // Board cards show generate buttons for missing documents; one listFiles per
  // open app (local fs, cheap). Closed/archived apps don't need the flags.
  const applications: BoardEntry[] = await Promise.all(
    index.applications.map(async (a) => {
      if (["rejected", "withdrawn", "expired"].includes(a.status) || a.archived) return a;
      const files = await store.listFiles(["applications", a.id]).catch(() => []);
      const names = new Set(files.map((f) => f.name));
      return { ...a, has_resume: names.has("resume.docx"), has_cover_letter: names.has("cover-letter.docx") };
    }),
  );
  return {
    applications,
    experiences: experiences.map((e) => ({
      fileName: e.fileName,
      company: e.frontmatter.company,
      title: e.frontmatter.title,
      dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
      domains: e.frontmatter.domains ?? [],
    })),
    profile,
    insightsHtml: insightsMd ? (marked.parse(insightsMd, { async: false }) as string) : null,
    home: process.env.KAIROS_HOME || `${process.env.HOME}/Kairos`,
  };
}

export interface ApplicationQuestion {
  question: string;
  answer: string;
}

export interface ApplicationDetail {
  meta: ApplicationMeta;
  report: ScoreReport | null;
  jobText: string | null;
  resumeHtml: string | null;
  coverLetterHtml: string | null;
  questions: ApplicationQuestion[];
  form: ApplicationForm | null;
  /** Last one-click generation failure, shown until the next successful run. */
  generationError: string | null;
  scoreVersions: ScoreVersion<ScoreReport>[];
  downloads: { resumeDocx: boolean; resumePdf: boolean; coverLetterDocx: boolean; submitted: string | null };
}

export async function getApplication(id: string): Promise<ApplicationDetail | null> {
  const store = getStore();
  const meta = await readMeta(store, id);
  if (!meta) return null;
  const base = ["applications", id];
  const [report, versions, snapshot, resumeMd, coverMd, questionsJson, form, genError, resumeDocx, resumePdf, coverDocx] =
    await Promise.all([
      readScoreReport<ScoreReport>(store, id),
      readScoreVersions<ScoreReport>(store, id),
      readSnapshot(store, id),
      readResumeSource(store, id),
      store.readFile([...base, "cover-letter.md"]),
      store.readJson<ApplicationQuestion[]>([...base, "questions.json"]),
      readApplicationForm(store, id),
      store.readFile([...base, "generation-error.txt"]),
      store.readBinary([...base, "resume.docx"]),
      store.readBinary([...base, "resume.pdf"]),
      store.readBinary([...base, "cover-letter.docx"]),
    ]);
  return {
    meta,
    report: versions.length ? versions[versions.length - 1].report : report,
    scoreVersions: versions,
    jobText: snapshot ? matter(snapshot).content.trim() : null,
    resumeHtml: resumeMd ? resumeMarkdownToHtml(resumeMd) : null,
    // breaks:true so the letterhead (name / contact) keeps its line breaks on screen.
    coverLetterHtml: coverMd ? (marked.parse(coverMd, { async: false, breaks: true }) as string) : null,
    questions: questionsJson ?? [],
    form,
    generationError: genError?.trim() ? genError.trim() : null,
    downloads: {
      resumeDocx: resumeDocx !== null,
      resumePdf: resumePdf !== null,
      coverLetterDocx: coverDocx !== null,
      submitted: meta.submitted_file ?? null,
    },
  };
}

// --- Knowledge base viewer -------------------------------------------------

export type KBDepth = "résumé-only" | "developing" | "rich";

export interface KBExperience {
  fileName: string;
  company: string;
  title: string;
  dates: string;
  location?: string;
  seniority?: string;
  domains: string[];
  scope: { key: string; value: string; prov: string }[];
  skills: { name: string; proficiency: string; recency: string; prov: string }[];
  bodyHtml: string;
  confirmedCount: number;
  depth: KBDepth;
}
export interface KBEducation {
  fileName: string;
  institution: string;
  credential: string;
  dates?: string;
  bodyHtml: string;
}
export interface KnowledgeBase {
  experiences: KBExperience[];
  education: KBEducation[];
  voiceProfileHtml: string | null;
}

/** How far beyond the résumé a role has been enriched — counts confirmed [C] facts. */
function depthOf(body: string): { confirmedCount: number; depth: KBDepth } {
  const confirmedCount = (body.match(/\[C\]/g) ?? []).length;
  const depth: KBDepth = confirmedCount === 0 ? "résumé-only" : confirmedCount < 4 ? "developing" : "rich";
  return { confirmedCount, depth };
}

/** Render KB markdown, turning [R]/[C]/[F] provenance tags into colored markers. */
function renderKbBody(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return html.replace(/\[(R|C|F)\]/g, (_m, p) => `<sup class="prov prov-${p}">[${p}]</sup>`);
}

export async function getHealth(): Promise<HealthReport> {
  const store = getStore();
  const [experiences, profileRaw] = await Promise.all([loadExperiences(store), store.readFile(["profile.md"])]);
  const profile = profileRaw ? (matter(profileRaw).data as Record<string, unknown>) : {};
  return computeHealth(experiences, {
    contactLine: typeof profile.contact_line === "string" ? profile.contact_line : undefined,
    headline: typeof profile.headline === "string" ? profile.headline : undefined,
  });
}

export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  const store = getStore();
  const [experiences, voice, eduFiles] = await Promise.all([
    loadExperiences(store),
    loadVoiceProfile(store),
    store.listFiles(["knowledge-base", "education"]),
  ]);

  const education: KBEducation[] = [];
  for (const f of eduFiles.filter((x) => x.name.endsWith(".md"))) {
    const raw = await store.readFile(["knowledge-base", "education", f.name]);
    if (!raw) continue;
    const p = matter(raw);
    education.push({
      fileName: f.name,
      institution: String(p.data.institution ?? f.name),
      credential: String(p.data.credential ?? ""),
      dates: p.data.dates ? String(p.data.dates) : undefined,
      bodyHtml: renderKbBody(p.content.trim()),
    });
  }

  return {
    experiences: experiences.map((e) => ({
      fileName: e.fileName,
      company: e.frontmatter.company,
      title: e.frontmatter.title,
      dates: `${e.frontmatter.start} – ${e.frontmatter.end}`,
      location: e.frontmatter.location,
      seniority: e.frontmatter.seniority_level,
      domains: e.frontmatter.domains ?? [],
      scope: Object.entries(e.frontmatter.scope ?? {}).map(([key, v]) => ({ key, value: v.value, prov: v.prov })),
      skills: (e.frontmatter.skills ?? []).map((s) => ({ name: s.name, proficiency: s.proficiency, recency: s.recency, prov: s.prov })),
      bodyHtml: renderKbBody(e.body),
      ...depthOf(e.body),
    })),
    education,
    voiceProfileHtml: voice ? (marked.parse(voice, { async: false }) as string) : null,
  };
}

/** Render resume-source.md into the on-screen "paper" HTML, matching the docx:
 *  "### Company | Location" and "#### Role | Dates" become right-aligned rows. */
function resumeMarkdownToHtml(md: string): string {
  let html = marked.parse(md, { async: false }) as string;
  html = html
    .replace(/<h1>([^<]*)<\/h1>/, (_m, n) => `<h1 class="r-name">${n}</h1>`)
    .replace(/<h3>([^|<]*?)\s*\|\s*([^<]*?)<\/h3>/g, '<div class="r-co"><span>$1</span><span>$2</span></div>')
    .replace(/<h3>([^<]*?)<\/h3>/g, '<div class="r-co"><span>$1</span></div>')
    .replace(/<h4>([^|<]*?)\s*\|\s*([^<]*?)<\/h4>/g, '<div class="r-role"><span>$1</span><span>$2</span></div>')
    .replace(/<h4>([^<]*?)<\/h4>/g, '<div class="r-role"><span>$1</span></div>');
  return html;
}
