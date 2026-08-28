import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "@/store/local-fs";
import { createApplication, loadIndex, upsertIndexEntry } from "@kairos/engine/applications";
import { saveGeneratedResume, saveScoredReport } from "@kairos/engine/tools/ops";
import type { GeneratedResume, ScoreReport } from "@kairos/engine/types";

/** Integration: the guarded ops against a real (temp) store with a real KB file. */

let store: LocalStore;
let appId: string;

const KB_FILE = `---
id: acme-pm
company: Acme
title: Product Manager
start: '2020'
end: '2022'
---

## Achievements
- Delivered $20M in savings and 90% adoption on the support platform. [R]
`;

const resume = (bullets: string[]): GeneratedResume => ({
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Product leader:** ships platforms with measured outcomes.",
    experience: [{ company: "Acme", title: "Product Manager", dates: "2020 – 2022", bullets }],
    education: [{ institution: "MIT", credential: "MBA" }],
    skills: ["Platforms"],
  },
  provenance_audit: [{ claim: "savings", source_experience: "01-acme-pm", prov: "R" }],
});

beforeAll(async () => {
  store = new LocalStore(await mkdtemp(path.join(tmpdir(), "kairos-test-")));
  await store.writeFile(["knowledge-base", "experiences", "01-acme-pm.md"], KB_FILE);
  const meta = await createApplication(store, {
    company: "Globex",
    role: "Head of Product",
    snapshotMarkdown: "# Head of Product\nWe want platform adoption, platform adoption, and support experience. Support matters.",
  });
  appId = meta.id;
});

describe("saveGeneratedResume (guarded)", () => {
  it("accepts a grounded, style-clean resume and writes json+md+docx together", async () => {
    const result = await saveGeneratedResume(store, appId, resume(["Delivered $20M in savings and 90% adoption."]));
    expect(result.provenanceEntries).toBe(1);
    expect(await store.readJson(["applications", appId, "resume.json"])).toBeTruthy();
    expect(await store.readFile(["applications", appId, "resume-source.md"])).toContain("$20M");
    expect(await store.readBinary(["applications", appId, "resume.docx"])).toBeTruthy();
    expect(result.ats.coverage).toBeGreaterThan(0);
  });

  it("hard-fails a metric the KB does not contain (anti-fabrication)", async () => {
    await expect(saveGeneratedResume(store, appId, resume(["Delivered $80M in savings."]))).rejects.toThrow(
      /ungrounded_metric/,
    );
  });

  it("hard-fails an employer that is not in the KB", async () => {
    const gen = resume(["Delivered $20M in savings."]);
    gen.resume.experience[0].company = "Initech";
    await expect(saveGeneratedResume(store, appId, gen)).rejects.toThrow(/unknown_employer/);
  });

  it("hard-fails house-style violations (em dash)", async () => {
    await expect(
      saveGeneratedResume(store, appId, resume(["Delivered $20M in savings — a big win."])),
    ).rejects.toThrow(/house style/);
  });

  it("hard-fails composite provenance tokens", async () => {
    const gen = resume(["Delivered $20M in savings."]);
    gen.provenance_audit[0].prov = "R/C" as never;
    await expect(saveGeneratedResume(store, appId, gen)).rejects.toThrow(/validation/);
  });
});

describe("saveScoredReport (guarded)", () => {
  it("rejects a malformed report and accepts a valid one", async () => {
    await expect(saveScoredReport(store, appId, "v1", { match: {} } as never)).rejects.toThrow(/validation/);
    const valid: ScoreReport = {
      parse_safety: { verdict: "PASS", checks: [], ats_specific_note: "n" },
      match: {
        detected_ats: "x",
        dimensions: [{ name: "hard_skills", score: 70, justification: "j" }],
        overall_band: "COMPETITIVE",
        confidence: "medium",
        pool_caveat: "Band reflects functional fit; true ranking unknowable.",
      },
      authenticity: { score: 90, flags: [], strengths: [] },
      gaps: [],
      reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "" },
      recommendation: "APPLY",
    };
    await expect(saveScoredReport(store, appId, "v1", valid)).resolves.toBeTruthy();
  });
});

describe("index concurrency", () => {
  it("does not lose entries under concurrent upserts", async () => {
    const before = (await loadIndex(store)).applications.length;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertIndexEntry(store, {
          id: `app-${i}`,
          company: `C${i}`,
          role: "R",
          status: "captured",
          captured_at: new Date(2026, 0, i + 1).toISOString(),
          updated_at: new Date().toISOString(),
        }),
      ),
    );
    expect((await loadIndex(store)).applications.length).toBe(before + 12);
  });
});

describe("lead-in title gate (user style feedback, 2026-07-28)", () => {
  it("flags claim-shaped lead-ins as hard violations", async () => {
    const { checkStyle, isHardStyleViolation } = await import("@kairos/engine/tools/checks");
    const bad = [
      "- **Owned outcomes, not requirements:** did the thing.",
      "- **Intelligent automation that removes manual effort:** saved money.",
      "- **Detect the work, complete the work:** agents.",
    ].join("\n");
    const violations = checkStyle(bad).filter((v) => v.rule === "leadin-not-title");
    expect(violations).toHaveLength(3);
    expect(violations.every(isHardStyleViolation)).toBe(true);
  });

  it("accepts condensed noun-phrase titles including connectors and parentheticals", async () => {
    const { checkStyle } = await import("@kairos/engine/tools/checks");
    const good = [
      "- **Global Expansion & Roadmap Execution:** ran the rollout.",
      "- **Platform Scale:** designed the platform.",
      "- **Protégé Vault (0-to-1, shipped):** led delivery.",
      "- **Netherlands Market Launch (P&L Owner):** owned it.",
    ].join("\n");
    expect(checkStyle(good).filter((v) => v.rule === "leadin-not-title")).toHaveLength(0);
  });
});
