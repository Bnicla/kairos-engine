/** Sourcing module shared shapes (spec: kairos-sourcing-v1-spec.md). */

export type SourcingAts = "greenhouse" | "lever" | "ashby" | "rippling" | "workday";

export interface RegistryEntry {
  ats: SourcingAts;
  /** Board slug; for workday: "tenant@wdN@site" composite. */
  slug: string;
  company?: string;
}

export interface Posting {
  ats: SourcingAts;
  slug: string;
  company: string;
  title: string;
  url: string;
  location: string;
  remote: boolean;
  /** ISO date when known; null when the feed doesn't say. */
  posted_at: string | null;
  /** Age in days at fetch time; null when posted_at is null. */
  age_days: number | null;
}

export interface SearchProfile {
  /** Title must contain one of these (function gate — deliberately loose). */
  function_terms: string[];
  /** Title containing any of these is dropped (noise gate). */
  exclude_terms: string[];
  /** Substrings marking a location as a direct match (lowercased compare). */
  locations: string[];
  /** Words that boost ranking when present in the title. */
  boost_terms: string[];
  /** Seniority words that boost ranking (rank, never gate — Suno lesson). */
  seniority_terms: string[];
  /** Hard recency cap in days (strong default: 7). */
  max_age_days: number;
  /** Companies the user especially wants (lowercased substrings matched
   *  against company name/slug). Strong rank boost, never a gate. */
  watched_companies?: string[];
  /** Locations acceptable ONLY for strong fits (higher bar than `locations`):
   *  a posting here must carry both a seniority and a domain signal to
   *  survive. Also exempts these places from the non-domestic drop, so
   *  international entries (e.g. "paris") work. */
  secondary_locations?: string[];
}

export interface RankedPosting extends Posting {
  rank_score: number;
  location_fit: "match" | "stretch";
  reasons: string[];
  /** Set by triage: rough fit guess (pre-screen, never a real score). */
  guess_band?: "STRONG" | "COMPETITIVE" | "DEVELOPING" | "WEAK";
  one_liner?: string;
  /**
   * Why a role that cleared the mechanical prefilter did NOT reach the final
   * board. Only set on the `dropped` list (the "view all sourced" surface):
   *   - "over_cap"     — beyond the triage input cap, never reviewed
   *   - "triage_cut"   — triage did not shortlist it
   *   - "same_company" — shortlisted, but another role held the company's slot
   *   - "below_cut"    — shortlisted, but ranked below the final cap
   */
  drop_reason?: "over_cap" | "triage_cut" | "same_company" | "below_cut";
}

export interface SweepResult {
  boards_swept: number;
  boards_failed: number;
  postings_fetched: number;
  survivors: RankedPosting[];
  stretch: RankedPosting[];
}
