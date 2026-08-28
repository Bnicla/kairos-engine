/** Shared result shapes for scoring + generation (used by API routes and UI). */

export interface ParseCheck {
  rule: string;
  result: "PASS" | "FAIL" | "UNKNOWN";
  detail: string;
}

export interface MatchDimension {
  name: string;
  score: number;
  justification: string;
}

export type MatchBand = "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";

export interface ScoreReport {
  parse_safety: {
    verdict: "PASS" | "ISSUES_FOUND";
    checks: ParseCheck[];
    ats_specific_note: string;
  };
  match: {
    detected_ats: string;
    dimensions: MatchDimension[];
    overall_band: MatchBand;
    confidence: "high" | "medium" | "low";
    pool_caveat: string;
  };
  authenticity: {
    score: number;
    flags: { issue: string; detail: string; where: string }[];
    strengths: string[];
  };
  gaps: {
    requirement: string;
    severity: "DEAL-BREAKER" | "IMPORTANT" | "NICE-TO-HAVE";
    type: "genuine_gap" | "possibly_uncaptured";
    clarifying_question: string | null;
  }[];
  reachable: {
    band_if_tailored: MatchBand;
    from_reframing: string[];
    needs_user_confirmation: string[];
    honest_ceiling_note: string;
  };
  recommendation:
    | "APPLY"
    | "APPLY_AFTER_TAILORING"
    | "STRETCH"
    | "NOT_RECOMMENDED";
}

export interface GeneratedResume {
  resume: {
    header: { name: string; contact: string };
    executive_summary: string;
    experience: {
      company: string;
      title: string;
      location?: string;
      dates: string;
      /** Optional one-line role intro shown under the role, above the bullets. */
      summary?: string;
      bullets: string[];
    }[];
    education: { institution: string; credential: string; dates?: string }[];
    skills: string[];
  };
  provenance_audit: {
    claim: string;
    source_experience: string;
    prov: string;
  }[];
  voice_notes?: string;
  tailoring_notes?: string;
  honest_ceiling_note?: string;
  dropped_for_relevance?: string[];
}
