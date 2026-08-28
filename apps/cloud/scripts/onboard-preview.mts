/**
 * Dev harness: exercise the onboarding pipeline WITHOUT Google Drive or a
 * per-user key. Two modes:
 *
 *   npm -w kairos-cloud run preview -- --kb <dir-of-experience-md-files>
 *     Pure grading: parse an on-disk KB and print the stage-aware health
 *     report. No network, no keys.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… npm -w kairos-cloud run preview -- <resume.pdf>
 *     Full pipeline: text extraction → Claude extraction → in-memory KB →
 *     health report. One key (yours, env var), zero Google.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FileEntry, FolderEntry, Store } from "@kairos/engine/store/types";
import { parseExperience } from "@kairos/engine/kb/experience";
import { loadExperiences, saveExperience } from "@kairos/engine/kb/store";
import { computeHealth, type HealthReport } from "@kairos/engine/health";
import { careerStage } from "@kairos/engine/length-policy";
import type { ExperienceFrontmatter } from "@kairos/engine/kb/types";

/** Minimal in-memory Store — enough for the KB read/write paths. */
class MemStore implements Store {
  private files = new Map<string, string>();
  private key(p: string[]) {
    return p.join("/");
  }
  async listFiles(folderPath: string[]): Promise<FileEntry[]> {
    const prefix = folderPath.length ? this.key(folderPath) + "/" : "";
    const out: FileEntry[] = [];
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest.includes("/")) out.push({ id: k, name: rest, mimeType: "text/markdown" });
    }
    return out;
  }
  async listFolders(): Promise<FolderEntry[]> {
    return [];
  }
  async readFile(filePath: string[]): Promise<string | null> {
    return this.files.get(this.key(filePath)) ?? null;
  }
  async readBinary(): Promise<Buffer | null> {
    return null;
  }
  async writeFile(filePath: string[], content: string): Promise<string> {
    this.files.set(this.key(filePath), content);
    return this.key(filePath);
  }
  async writeBinary(filePath: string[]): Promise<string> {
    return this.key(filePath);
  }
  async readJson<T>(filePath: string[]): Promise<T | null> {
    const raw = await this.readFile(filePath);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async writeJson(filePath: string[], data: unknown): Promise<string> {
    return this.writeFile(filePath, JSON.stringify(data, null, 2));
  }
}

function printReport(report: HealthReport) {
  console.log(`\nSTAGE: ${report.stage}   OVERALL: ${report.overall}/100`);
  console.log(`VERDICT: ${report.verdict}\n`);
  for (const d of report.dimensions) {
    const mark = d.status === "strong" ? "✓" : d.status === "weak" ? "✗" : "·";
    console.log(`${mark} ${String(d.score)}/5  ${d.label.padEnd(28)} ${d.detail}`);
    if (d.fix) console.log(`         fix: ${d.fix}`);
  }
  if (report.topFixes.length) {
    console.log("\nTOP FIXES:");
    report.topFixes.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log(
    `\ncounts: ${report.counts.experiences} entries, ${report.counts.bullets} bullets, ${report.counts.quantified} quantified, ${report.counts.confirmed} confirmed\n`,
  );
}

async function kbMode(dir: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  const experiences = files
    .sort()
    .map((f) => parseExperience(f, readFileSync(join(dir, f), "utf8")));
  if (!experiences.length) throw new Error(`No experience .md files in ${dir}`);
  console.log(`Loaded ${experiences.length} entries from ${dir}`);
  console.log(`Derived stage: ${careerStage(experiences)}`);
  printReport(computeHealth(experiences));
  // Show the other curves for comparison.
  for (const stage of ["early", "senior"] as const) {
    const r = computeHealth(experiences, { stage });
    console.log(`(forced ${stage} curve: ${r.overall}/100)`);
  }
}

async function resumeMode(path: string) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY for full-pipeline mode, or use --kb <dir>.");
  const { extractResumeText } = await import("@kairos/engine/extract-text");
  const { extractKnowledgeBase } = await import("../lib/claude");

  const buf = readFileSync(path);
  const file = new File([new Uint8Array(buf)], basename(path));
  const text = await extractResumeText(file);
  console.log(`Extracted ${text.length} chars of text from ${basename(path)}. Calling Claude…`);

  const result = await extractKnowledgeBase(key, text);
  const store = new MemStore();
  for (const exp of result.experiences) {
    await saveExperience(store, {
      fileName: exp.fileName,
      frontmatter: exp.frontmatter as unknown as ExperienceFrontmatter,
      body: exp.body.trim(),
    });
  }
  console.log(`\nCandidate: ${result.candidate.name}${result.candidate.headline ? ` · ${result.candidate.headline}` : ""}`);
  console.log(`Extracted ${result.experiences.length} experience entries:`);
  for (const e of result.experiences) console.log(`  - ${e.fileName}`);
  console.log(`Education entries: ${result.education?.length ?? 0}`);

  const experiences = await loadExperiences(store);
  printReport(
    computeHealth(experiences, {
      contactLine: result.candidate.contact,
      headline: result.candidate.headline?.trim(),
    }),
  );
}

const args = process.argv.slice(2);
const kbIdx = args.indexOf("--kb");
if (kbIdx !== -1 && args[kbIdx + 1]) {
  await kbMode(args[kbIdx + 1]);
} else if (args[0] && statSync(args[0], { throwIfNoEntry: false })) {
  await resumeMode(args[0]);
} else {
  console.log("Usage:\n  preview -- --kb <dir of experience .md files>\n  ANTHROPIC_API_KEY=… preview -- <resume.pdf|docx|txt>");
  process.exit(1);
}
