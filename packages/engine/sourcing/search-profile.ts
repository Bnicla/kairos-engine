/**
 * Per-user sourcing preferences. The search profile that drives the sweep is
 * USER DATA (sourcing/search-profile.json), never constants in code. First run
 * derives sensible defaults from the candidate's profile.md; after that the
 * stored file wins, and the preferences conversation edits it.
 */

import type { Store } from "@kairos/engine/store/types";
import type { SearchProfile } from "./types";

export const SEARCH_PROFILE_PATH = ["sourcing", "search-profile.json"];

export interface StoredSearchProfile extends SearchProfile {
  /** Free-text notes from the preferences conversation (context for triage). */
  notes?: string;
  /** When false (default), postings with clearly non-domestic locations are dropped. */
  international_ok?: boolean;
  updated_at: string;
  /** "derived" until the user has confirmed it in a conversation. */
  source: "derived" | "confirmed";
}

/** Frontmatter shape of profile.md that the derivation reads. */
export interface CandidateProfileFrontmatter {
  target_roles?: string[];
  target_seniority?: string;
  domains?: string[];
  preferences?: { location?: string } & Record<string, unknown>;
  role_shape_preference?: string;
}

const SENIORITY_VOCAB = [
  "principal", "staff", "senior", "lead", "director", "head of", "vp",
  "vice president", "group", "chief", "manager",
];

const DISCIPLINE_VOCAB = [
  "product", "engineering", "engineer", "design", "designer", "data",
  "marketing", "sales", "research", "operations", "finance", "security",
  "analytics", "science", "scientist",
];

/** Generic noise no matter the discipline; refined per-user in conversation. */
const DEFAULT_EXCLUDES = ["intern", "internship", "junior", "coordinator", "apprentice"];

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Derive a starting search profile from the candidate's own profile.md.
 * Heuristic by design: the preferences conversation is where it gets exact.
 */
export function deriveSearchProfile(
  fm: CandidateProfileFrontmatter,
  now: () => string = () => new Date().toISOString(),
): StoredSearchProfile {
  const roleText = (fm.target_roles ?? []).map(norm).join(" ");
  const seniorityText = `${roleText} ${norm(fm.target_seniority ?? "")}`;

  const function_terms = DISCIPLINE_VOCAB.filter((d) => roleText.includes(d));
  if (function_terms.length === 0 && fm.target_roles?.length) {
    // Unknown discipline: fall back to the meaningful words of the first target role.
    function_terms.push(
      ...norm(fm.target_roles[0]).split(/[^a-z]+/).filter((w) => w.length > 3),
    );
  }

  const seniority_terms = SENIORITY_VOCAB.filter((s) => seniorityText.includes(s));

  // Locations from the stated preference, split on common separators. The
  // sweep treats these as "counts as local" markers; remote postings match
  // through the remote flag, not this list.
  const locations = (fm.preferences?.location ?? "")
    .split(/[\/,;·]| or | and /i)
    .map(norm)
    .filter((l) => l.length > 1);

  const boost_terms = (fm.domains ?? []).map(norm);

  return {
    function_terms: function_terms.length ? [...new Set(function_terms)] : ["product"],
    exclude_terms: [...DEFAULT_EXCLUDES],
    locations,
    boost_terms,
    seniority_terms,
    max_age_days: 7,
    ...(fm.role_shape_preference ? { notes: fm.role_shape_preference } : {}),
    international_ok: false,
    secondary_locations: [],
    updated_at: now(),
    source: "derived",
  };
}

export const loadSearchProfile = (s: Store) =>
  s.readJson<StoredSearchProfile>(SEARCH_PROFILE_PATH);

export const saveSearchProfile = (s: Store, p: StoredSearchProfile) =>
  s.writeJson(SEARCH_PROFILE_PATH, p);

/** Human-readable summary for the settings page and the conversation opener. */
export function describeSearchProfile(p: StoredSearchProfile): string {
  const lines = [
    `Discipline terms: ${p.function_terms.join(", ") || "(none)"}`,
    `Seniority terms: ${p.seniority_terms.join(", ") || "(any)"}`,
    `Locations counted as local: ${p.locations.join(", ") || "(none — remote only)"}`,
    `Higher-bar locations (strong fits only): ${(p.secondary_locations ?? []).join(", ") || "(none)"}`,
    `Interest boosts: ${p.boost_terms.join(", ") || "(none)"}`,
    `Excluded words: ${p.exclude_terms.join(", ") || "(none)"}`,
    `Freshness window: postings from the last ${p.max_age_days} days`,
    `International postings: ${p.international_ok ? "included" : "excluded"}`,
  ];
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  lines.push(p.source === "derived" ? "(Derived automatically from your profile — not yet confirmed.)" : "(Confirmed by you.)");
  return lines.join("\n");
}
