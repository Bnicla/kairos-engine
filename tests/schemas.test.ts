import { describe, expect, it } from "vitest";
import { GeneratedResumeSchema, ScoreReportSchema } from "@kairos/engine/tools/schemas";

const validResume = {
  resume: {
    header: { name: "Alex Sample", contact: "Chicago" },
    executive_summary: "- **Leader:** does things.",
    experience: [{ company: "Acme", title: "PM", dates: "2020 – 2022", bullets: ["Did a thing."] }],
    education: [{ institution: "MIT", credential: "MBA" }],
    skills: ["AI"],
  },
  provenance_audit: [{ claim: "Did a thing", source_experience: "01-acme", prov: "R" }],
};

describe("GeneratedResumeSchema", () => {
  it("accepts a well-formed resume", () => {
    expect(GeneratedResumeSchema.safeParse(validResume).success).toBe(true);
  });

  it('rejects composite prov tokens like "R/C" (one claim, one provenance)', () => {
    const bad = structuredClone(validResume);
    bad.provenance_audit[0].prov = "R/C";
    expect(GeneratedResumeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty provenance audit or empty bullets", () => {
    const noAudit = structuredClone(validResume) as Record<string, unknown>;
    (noAudit as typeof validResume).provenance_audit = [];
    expect(GeneratedResumeSchema.safeParse(noAudit).success).toBe(false);
  });
});

const validScore = {
  parse_safety: { verdict: "PASS", checks: [{ rule: "x", result: "PASS", detail: "d" }], ats_specific_note: "n" },
  match: {
    detected_ats: "Workday",
    dimensions: [{ name: "hard_skills", score: 80, justification: "j" }],
    overall_band: "COMPETITIVE",
    confidence: "medium",
    pool_caveat: "True ranking is unknowable; band reflects functional fit.",
  },
  authenticity: { score: 90, flags: [], strengths: ["specific"] },
  gaps: [],
  reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "n" },
  recommendation: "APPLY",
};

describe("ScoreReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(ScoreReportSchema.safeParse(validScore).success).toBe(true);
  });

  it("rejects invalid bands and missing pool caveat (N2)", () => {
    const badBand = structuredClone(validScore);
    badBand.match.overall_band = "AMAZING";
    expect(ScoreReportSchema.safeParse(badBand).success).toBe(false);

    const noCaveat = structuredClone(validScore);
    noCaveat.match.pool_caveat = "";
    expect(ScoreReportSchema.safeParse(noCaveat).success).toBe(false);
  });
});
