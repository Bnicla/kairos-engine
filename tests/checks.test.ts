import { describe, expect, it } from "vitest";
import {
  checkAtsCoverage,
  checkResumeGrounding,
  checkStyle,
  extractMetricTokens,
  isHardStyleViolation,
} from "@kairos/engine/tools/checks";
import type { Experience } from "@kairos/engine/kb/types";
import type { GeneratedResume } from "@kairos/engine/types";

describe("checkStyle", () => {
  it("flags em dashes, banned words, and the not-just-but pattern as hard violations", () => {
    const v = checkStyle("We spearheaded a change — not just a tweak but a rewrite.");
    const rules = v.map((x) => x.rule);
    expect(rules).toContain("em-dash");
    expect(rules).toContain("banned-word");
    expect(rules).toContain("not-just-but");
    expect(v.filter(isHardStyleViolation).length).toBeGreaterThanOrEqual(3);
  });

  it("treats empty adverbs as soft and passes clean text", () => {
    const soft = checkStyle("This was extremely fast.");
    expect(soft.every((x) => !isHardStyleViolation(x))).toBe(true);
    expect(checkStyle("Cut validation time 60% and improved accuracy 40%.")).toEqual([]);
  });

  it("warns (softly) when the same verb opens 4+ bullets", () => {
    const md = ["- **A:** Drove x.", "- **B:** Drove y.", "- Drove z.", "- **C:** Drove w.", "- **D:** Led v."].join("\n");
    const v = checkStyle(md);
    const cluster = v.find((x) => x.rule === "verb-clustering");
    expect(cluster?.detail).toContain('"drove" opens 4');
    expect(cluster && !isHardStyleViolation(cluster)).toBe(true);
  });
});

describe("extractMetricTokens", () => {
  it("extracts claim-bearing metrics and skips years and tenure math", () => {
    const tokens = extractMetricTokens(
      "Delivered $20M in savings, 600% productivity, 35+ teams, 100,000 documents, 500M+ devices in 2024. 15+ years of work.",
    ).map((t) => t.raw);
    expect(tokens).toEqual(expect.arrayContaining(["$20M", "600%", "35+", "100,000", "500M+"]));
    expect(tokens).not.toContain("2024");
    expect(tokens.some((t) => t.startsWith("15+"))).toBe(false);
  });
});

const kbExp = (company: string, body: string, fileName = "01-test.md"): Experience =>
  ({
    fileName,
    frontmatter: { id: "t", company, title: "PM", start: "2020", end: "2022" },
    body,
  }) as unknown as Experience;

const resume = (company: string, bullets: string[], source = "01-test"): GeneratedResume => ({
  resume: {
    header: { name: "A", contact: "b" },
    executive_summary: "Product leader.",
    experience: [{ company, title: "PM", dates: "2020 – 2022", bullets }],
    education: [],
    skills: [],
  },
  provenance_audit: [{ claim: "x", source_experience: source, prov: "R" }],
});

describe("checkResumeGrounding", () => {
  const kb = [kbExp("Acme", "- Delivered $20M in savings and 90% adoption. [R]")];

  it("passes when employers and metrics trace to the KB", () => {
    expect(checkResumeGrounding(resume("Acme", ["Delivered $20M in savings.", "Reached 90% adoption."]), kb)).toEqual([]);
  });

  it("rejects unknown employers, invented metrics, and unknown provenance sources", () => {
    const issues = checkResumeGrounding(resume("Globex", ["Delivered $50M in savings."], "99-nope"), kb);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("unknown_employer");
    expect(kinds).toContain("ungrounded_metric");
    expect(kinds).toContain("unknown_source");
  });

  it("does not ground metrics on [?] facts (stripped corpus)", () => {
    const kbUnverified = [kbExp("Acme", "- Delivered $20M in savings. [R]\n- Grew revenue 300%. [?]")];
    const issues = checkResumeGrounding(resume("Acme", ["Grew revenue 300%."]), kbUnverified);
    expect(issues.map((i) => i.kind)).toContain("ungrounded_metric");
  });
});

describe("checkAtsCoverage", () => {
  it("reports coverage of the JD's salient terms", () => {
    const jd =
      "We need product roadmaps and product roadmaps discipline. AI governance and AI governance experience. GDPR compliance required. Kubernetes preferred. Kubernetes daily.";
    const good = checkAtsCoverage(jd, "Set AI governance and product roadmaps under GDPR.");
    expect(good.coverage).toBeGreaterThan(0.5);
    expect(good.missing.join(" ")).toContain("kubernetes");
    const bad = checkAtsCoverage(jd, "I write poetry.");
    expect(bad.coverage).toBeLessThan(0.2);
  });
});
