"use server";

import { redirect } from "next/navigation";
import JSZip from "jszip";
import { revalidatePath } from "next/cache";
import { signIn, signOut } from "../auth";
import { getAnthropicKey, getSessionContext, isContextError, setAnthropicKey } from "../lib/session";
import { parseDocxTemplate } from "../lib/template-parse";
import { extractResumeText } from "@kairos/engine/extract-text";
import { ClaudeUserError, extractKnowledgeBase } from "../lib/claude";
import { loadExperiences, regenerateIndexMap, saveExperience, saveVoiceProfile } from "@kairos/engine/kb/store";
import { computeHealth } from "@kairos/engine/health";
import type { ExperienceFrontmatter } from "@kairos/engine/kb/types";
import { ALL_STATUSES, STATUS_META, removeIndexEntry, updateMeta, type ApplicationMeta, type ApplicationStatus } from "@kairos/engine/applications";
import { runCoverLetterForApp, runGenerationForApp } from "../lib/apps-agent";

/**
 * Server actions for the settings flow. Feedback travels via query params
 * (?ok= / ?e=) because form-bound actions must return void.
 */

export async function signInAction() {
  await signIn("google");
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}

const back = (msg: { ok?: string; e?: string }): never =>
  redirect(`/settings?${new URLSearchParams(msg as Record<string, string>)}`);

/** First connect: create the Kairos/ tree in the user's Drive. Idempotent. */
export async function initDriveAction(): Promise<void> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  try {
    await ctx.store.initTree();
  } catch (err) {
    // Most common cause: Drive permission denied (granular consent, revoked
    // access). A crash page helps nobody; explain and point at the fix.
    console.error("initTree failed:", err);
    back({
      e: "Couldn't reach your Google Drive. Sign out and sign in again, keeping the Drive permission checked; if it keeps failing, contact us.",
    });
  }
  revalidatePath("/settings");
  back({ ok: "Your Kairos/ folder is ready in Drive." });
}

/** Encrypt the user's Anthropic key into THEIR Drive (DEC-5: we keep nothing). */
export async function saveKeyAction(formData: FormData): Promise<void> {
  const key = String(formData.get("anthropic_key") ?? "").trim();
  if (!key.startsWith("sk-ant-") || key.length < 20) {
    back({ e: "That doesn't look like an Anthropic API key (sk-ant-…)." });
  }
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  try {
    await setAnthropicKey(ctx.store, key);
  } catch (err) {
    console.error("setAnthropicKey failed:", err);
    back({ e: "Couldn't write to your Google Drive. Set up your Drive first (step 1), then retry." });
  }
  revalidatePath("/settings");
  back({ ok: "Key encrypted and stored in your Drive." });
}

// Data import (Settings): a zip of a Kairos tree (e.g. the local lane's
// ~/Kairos folder) replaces the cloud content zones wholesale.
const IMPORT_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
};
const IMPORT_TEXT_EXT = new Set(["md", "json", "txt"]);
const IMPORT_ZONES = ["applications", "knowledge-base", "qa-bank"];

export async function importArchiveAction(formData: FormData): Promise<void> {
  const file = formData.get("archive");
  if (!(file instanceof File) || !file.name.endsWith(".zip")) back({ e: "Upload a .zip archive." });
  const f = file as File;
  if (f.size > 4 * 1024 * 1024) back({ e: "Archive is too large (4MB max). Zip without render artifacts and retry." });
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(Buffer.from(await f.arrayBuffer()));
  } catch {
    back({ e: "Couldn't read that file as a zip archive." });
  }
  const entries = Object.values(zip!.files).filter(
    (e) =>
      !e.dir &&
      !e.name.startsWith("__MACOSX") &&
      !e.name.includes(".DS_Store") &&
      !e.name.startsWith("_render-test/"),
  );
  const looksLikeKairos = entries.some(
    (e) => e.name === "_index.json" || e.name.startsWith("knowledge-base/") || e.name.startsWith("applications/"),
  );
  if (!looksLikeKairos) {
    back({ e: "That doesn't look like a Kairos folder export (no _index.json, knowledge-base/ or applications/ inside)." });
  }

  let written = 0;
  try {
    // Replace, not merge: the archive's content zones become the truth.
    for (const zone of IMPORT_ZONES) await ctx.store.deleteFolder([zone]);
    // Pre-create every folder sequentially so the parallel writes below never
    // race to create the same Drive folder.
    const dirs = [...new Set(entries.map((e) => e.name.split("/").slice(0, -1).join("/")).filter(Boolean))].sort();
    for (const dir of dirs) await ctx.store.ensureFolder(dir.split("/"));

    const CONCURRENCY = 8;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      await Promise.all(
        entries.slice(i, i + CONCURRENCY).map(async (e) => {
          const path = e.name.split("/");
          const ext = e.name.split(".").pop()!.toLowerCase();
          if (IMPORT_TEXT_EXT.has(ext)) {
            await ctx.store.writeFile(path, await e.async("text"), IMPORT_MIME[ext]);
          } else {
            await ctx.store.writeBinary(path, await e.async("nodebuffer"), IMPORT_MIME[ext] ?? "application/octet-stream");
          }
          written++;
        }),
      );
    }
  } catch (err) {
    console.error("import failed:", err);
    back({
      e: `Import stopped after ${written} of ${entries.length} files (Drive hiccup, most likely). Running it again is safe; it replaces everything.`,
    });
  }
  revalidatePath("/");
  revalidatePath("/settings");
  back({ ok: `Imported ${written} files. Applications, knowledge base and answer bank now match the archive.` });
}

/**
 * Template upload (DEC-8): parse the .docx for DESIGN only, store both the
 * original and the extracted overrides in the user's Drive templates/.
 */
export async function uploadTemplateAction(formData: FormData): Promise<void> {
  const file = formData.get("template");
  if (!(file instanceof File) || !file.name.endsWith(".docx")) back({ e: "Upload a .docx file." });
  const f = file as File;
  if (f.size > 5 * 1024 * 1024) back({ e: "Template is too large (5MB max)." });
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const buffer = Buffer.from(await f.arrayBuffer());
  let parsed;
  try {
    parsed = await parseDocxTemplate(buffer);
    await ctx.store.writeBinary(["templates", "template.docx"], buffer, f.type || "application/octet-stream");
    await ctx.store.writeJson(["templates", "template-spec.json"], {
      overrides: parsed.overrides,
      detected: parsed.detected,
      source: f.name,
      uploaded_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("template upload failed:", err);
    back({ e: "Couldn't read or store that template. Is it a valid .docx? If Drive is the problem, redo step 1 and retry." });
  }
  revalidatePath("/settings");
  back({
    ok: parsed!.detected.length
      ? `Template saved. Detected: ${parsed!.detected.join(", ")}.`
      : "Template saved; no design overrides detected, so the default design stays.",
  });
}

const KB = "knowledge-base";
const oops = (msg: string): never => redirect(`/onboard?e=${encodeURIComponent(msg)}`);

/** Frontmatter → YAML via JSON-quoted scalars (valid YAML, no extra dep). */
function toYamlDoc(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

const SAFE_MD = /^[\w][\w. -]*\.md$/;

/**
 * The onboarding core (§14): résumé file → text → Claude extraction (student's
 * own key) → provenance-tagged KB in THEIR Drive → deterministic health report.
 * Re-running replaces the previous extraction (same file names, overwritten).
 */
export async function onboardResumeAction(formData: FormData): Promise<void> {
  const file = formData.get("resume");
  if (!(file instanceof File) || file.size === 0) oops("Choose your résumé file first.");
  const f = file as File;
  if (f.size > 10 * 1024 * 1024) oops("That file is too large (10MB max).");

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const key = await getAnthropicKey(ctx.store);
  if (!key) oops("Add your Anthropic API key in settings first. Kairos reads the résumé with Claude on your key.");

  let text = "";
  try {
    text = await extractResumeText(f);
  } catch (err) {
    oops(err instanceof Error ? err.message : "Couldn't read that file.");
  }
  if (text.length < 200) {
    oops("Couldn't read enough text from that file. If it's a scanned image PDF, export a text-based PDF or DOCX and retry.");
  }

  await ctx.store.initTree();

  let result;
  try {
    result = await extractKnowledgeBase(key!, text);
  } catch (err) {
    if (err instanceof ClaudeUserError) oops(err.message);
    throw err;
  }
  if (!result!.experiences.length) {
    oops("No work experience found in that document. Make sure it's your résumé, or add at least one role to it.");
  }

  // Persist to the student's Drive, all facts [R].
  const seen = new Set<string>();
  let i = 0;
  for (const exp of result!.experiences.slice(0, 20)) {
    i += 1;
    let fileName = SAFE_MD.test(exp.fileName) ? exp.fileName : `${String(i).padStart(2, "0")}-experience.md`;
    if (seen.has(fileName)) fileName = `${String(i).padStart(2, "0")}-${fileName}`;
    seen.add(fileName);
    await saveExperience(ctx.store, {
      fileName,
      frontmatter: exp.frontmatter as unknown as ExperienceFrontmatter,
      body: exp.body.trim(),
    });
  }
  for (const ed of result!.education ?? []) {
    const fileName = SAFE_MD.test(ed.fileName) ? ed.fileName : "education.md";
    await ctx.store.writeFile([KB, "education", fileName], toYamlDoc(ed.frontmatter, ed.body));
  }
  if (result!.voice_profile) await saveVoiceProfile(ctx.store, result!.voice_profile);

  const today = new Date().toISOString().slice(0, 10);
  const headline = result!.candidate.headline?.trim();
  await ctx.store.writeFile(
    ["profile.md"],
    `# ${result!.candidate.name}\n\n${headline ? `${headline}\n\n` : ""}${result!.candidate.contact}\n\nSource: extracted from uploaded résumé (${f.name}) on ${today}. All facts tagged [R].\n`,
  );
  await regenerateIndexMap(ctx.store);

  // First deliverable: the job-agnostic health report, computed deterministically.
  const experiences = await loadExperiences(ctx.store);
  const health = computeHealth(experiences, { contactLine: result!.candidate.contact, headline });
  await ctx.store.writeJson([KB, "_health.json"], { ...health, generated_at: new Date().toISOString(), source: f.name });

  revalidatePath("/");
  revalidatePath("/kb");
  redirect("/kb?fresh=1");
}

// ============================================================================
// APPLICATIONS
// ============================================================================

export async function generateResumeAction(formData: FormData): Promise<void> {
  const appId = String(formData.get("appId") ?? "");
  const detail = (msg: { ok?: string; e?: string }): never =>
    redirect(`/applications/${encodeURIComponent(appId)}?${new URLSearchParams(msg as Record<string, string>)}`);

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const key = await getAnthropicKey(ctx.store);
  if (!key) detail({ e: "Add your Anthropic API key in settings first." });

  // The success redirect must live OUTSIDE the try: Next's redirect() works by
  // throwing, and a catch around it would report success as an error.
  let outcome;
  try {
    outcome = await runGenerationForApp(key!, ctx.store, appId);
  } catch (err) {
    detail({ e: err instanceof Error ? err.message : "Generation failed." });
  }
  revalidatePath(`/applications/${appId}`);
  detail({ ok: `Résumé drafted. ATS coverage ${(outcome!.atsCoverage * 100).toFixed(0)}%.` });
}

export async function generateCoverLetterAction(formData: FormData): Promise<void> {
  const appId = String(formData.get("appId") ?? "");
  const detail = (msg: { ok?: string; e?: string }): never =>
    redirect(`/applications/${encodeURIComponent(appId)}?${new URLSearchParams(msg as Record<string, string>)}`);

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const key = await getAnthropicKey(ctx.store);
  if (!key) detail({ e: "Add your Anthropic API key in settings first." });

  try {
    await runCoverLetterForApp(key!, ctx.store, appId);
  } catch (err) {
    detail({ e: err instanceof Error ? err.message : "Cover letter failed." });
  }
  revalidatePath(`/applications/${appId}`);
  detail({ ok: "Cover letter drafted, in your voice." });
}

/**
 * ONE action for the status card: an optional status transition (from whichever
 * button was clicked), an optional note, and an optional as-sent file — in any
 * combination. Replaces the old separate set-status and mark-submitted forms.
 */
/** Archive (or restore) an application: hidden from the default board view. */
export async function archiveAction(formData: FormData): Promise<void> {
  const appId = String(formData.get("appId") ?? "");
  const archive = String(formData.get("archived") ?? "1") === "1";
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  await updateMeta(ctx.store, appId, { archived: archive });
  revalidatePath("/");
  redirect(archive ? "/" : "/?archived=1");
}

/**
 * Purge an application entirely: the Drive folder (snapshot, scores, résumés)
 * and its index entry. For jobs the user decided not to pursue.
 */
export async function deleteApplicationAction(formData: FormData): Promise<void> {
  const appId = String(formData.get("appId") ?? "");
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  try {
    await ctx.store.deleteFolder(["applications", appId]);
    await removeIndexEntry(ctx.store, appId);
  } catch (err) {
    console.error("delete application failed:", err);
    redirect(`/applications/${encodeURIComponent(appId)}?${new URLSearchParams({ e: "Couldn't delete it from Drive. Try again." })}`);
  }
  revalidatePath("/");
  redirect("/");
}

export async function progressAction(formData: FormData): Promise<void> {
  const appId = String(formData.get("appId") ?? "");
  const detail = (msg: { ok?: string; e?: string }): never =>
    redirect(`/applications/${encodeURIComponent(appId)}?${new URLSearchParams(msg as Record<string, string>)}`);

  const rawStatus = String(formData.get("status") ?? "").trim();
  const status = rawStatus as ApplicationStatus;
  if (rawStatus && !ALL_STATUSES.includes(status)) detail({ e: "Unknown status." });
  const note = String(formData.get("note") ?? "").trim();
  const file = formData.get("sent_file");
  const hasFile = file instanceof File && file.size > 0;
  if (!rawStatus && !hasFile && !note) detail({ e: "Nothing to save." });

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");

  const patch: Partial<ApplicationMeta> = {};
  const noteParts: string[] = [];

  if (hasFile) {
    const f = file as File;
    if (f.size > 10 * 1024 * 1024) detail({ e: "File too large (10MB max)." });
    const safeName = `submitted-${f.name.replace(/[^\w. -]/g, "_")}`;
    await ctx.store.writeBinary(
      ["applications", appId, safeName],
      Buffer.from(await f.arrayBuffer()),
      f.type || "application/octet-stream",
    );
    patch.submitted_file = safeName;
    noteParts.push(`sent file: ${f.name}`);
  }

  if (rawStatus) {
    patch.status = status;
    if (status === "applied") patch.applied_at = new Date().toISOString();
  } else if (hasFile) {
    // Attaching what you sent means you applied.
    patch.status = "applied";
    patch.applied_at = new Date().toISOString();
  }
  if (note) noteParts.push(note);

  await updateMeta(ctx.store, appId, patch, noteParts.length ? { statusNote: noteParts.join(" · ") } : undefined);
  revalidatePath("/");
  revalidatePath(`/applications/${appId}`);
  detail({
    ok: patch.status ? `Status: ${STATUS_META[patch.status].label}${hasFile ? ", sent file attached" : ""}` : "Saved.",
  });
}
