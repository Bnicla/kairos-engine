import type { Posting, RankedPosting, SearchProfile } from "./types";

/**
 * Deterministic prefilter + ranking (spec §6, with the 2026-07-28 amendments):
 *  - function gate only (loose); seniority RANKS, never gates (Suno lesson)
 *  - location mismatch on an otherwise-strong posting → labeled "stretch"
 *    bucket, never silently dropped (Rippling/Anthropic lesson)
 *  - STRONG recency bias: hard cap at max_age_days (default 7); ranking is
 *    newest-first inside the window. Unknown-date postings survive the gate
 *    (some feeds carry no date) but rank below any dated posting.
 */

const norm = (s: string) => s.toLowerCase();

/** Word-boundary match: "product" must not match "production". */
const hasWord = (text: string, term: string) =>
  new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

export function passesFunctionGate(title: string, profile: SearchProfile): boolean {
  if (profile.exclude_terms.some((x) => hasWord(title, x))) return false;
  return profile.function_terms.some((f) => hasWord(title, f));
}

// Postings clearly outside the US are dropped outright — a remote flag on a
// "Remote (Germany)" posting does not make it applicable from Chicago.
const NON_US_MARKERS = [
  "germany", "france", "spain", "poland", "sweden", "austria", "portugal", "ireland",
  "netherlands", "belgium", "italy", "switzerland", "denmark", "norway", "finland",
  "united kingdom", " uk", "london", "dublin", "berlin", "paris", "amsterdam", "prague",
  "india", "bangalore", "singapore", "japan", "tokyo", "china", "korea", "seoul",
  "hong kong", "taiwan", "taipei", "vietnam", "thailand", "indonesia", "malaysia",
  "philippines", "australia", "sydney", "canada", "toronto", "vancouver", "brazil",
  "mexico", "israel", "emea", "apac", "latam",
  // City-only strings that dodge the country markers (observed leaks + the
  // common offenders). Ambiguous names with real US collisions (london,
  // dublin, athens) stay off the list on purpose.
  "vienna", "zurich", "geneva", "buenos aires", "hyderabad", "mumbai", "pune",
  "chennai", "gurgaon", "noida", "bengaluru", "warsaw", "krakow", "wroclaw",
  "bratislava", "budapest", "bucharest", "sofia", "lisbon", "porto", "madrid",
  "barcelona", "milan", "rome", "stockholm", "gothenburg", "oslo", "copenhagen",
  "helsinki", "tallinn", "riga", "vilnius", "brussels", "antwerp", "munich",
  "hamburg", "frankfurt", "cologne", "stuttgart", "zagreb", "ljubljana",
  "athens, gr", "slovakia", "slovenia", "croatia", "serbia", "romania",
  "bulgaria", "greece", "hungary", "czech", "estonia", "latvia", "lithuania",
  "ukraine", "turkey", "istanbul", "tel aviv", "jerusalem", "cairo", "nairobi",
  "cape town", "johannesburg", "argentina", "colombia", "chile", "peru",
  "uruguay", "bogota", "santiago", "lima", "montevideo", "mexico city",
  "guadalajara", "monterrey", "sao paulo", "rio de janeiro", "waterford",
  "cork", "galway", "limerick", "new zealand", "auckland", "wellington",
  "melbourne", "brisbane", "montreal", "ottawa", "calgary", "edmonton",
];
const US_MARKERS = ["united states", "usa", "u.s", " us", "us -", "- us", "(us", "north america"];

export function isNonUs(location: string): boolean {
  const loc = ` ${norm(location)}`;
  if (US_MARKERS.some((m) => loc.includes(m))) return false;
  return NON_US_MARKERS.some((m) => loc.includes(m));
}

export function locationFit(p: Posting, profile: SearchProfile): "match" | "stretch" {
  if (p.remote) return "match";
  const loc = norm(p.location);
  return profile.locations.some((l) => loc.includes(norm(l))) ? "match" : "stretch";
}

/** True when the posting's location contains one of the primary location markers. */
export function locationMatches(p: Posting, profile: SearchProfile): boolean {
  const loc = norm(p.location);
  return profile.locations.some((l) => loc.includes(norm(l)));
}

/** True when the posting sits in one of the user's higher-bar secondary locations. */
export function inSecondaryLocation(p: Posting, profile: SearchProfile): boolean {
  const loc = norm(p.location);
  return (profile.secondary_locations ?? []).some((l) => loc.includes(norm(l)));
}

/** Strong-fit test for secondary locations: both a seniority and a domain signal. */
export function meetsSecondaryBar(p: Posting, profile: SearchProfile): boolean {
  const t = norm(p.title);
  return (
    profile.seniority_terms.some((s) => t.includes(norm(s))) &&
    profile.boost_terms.some((b) => t.includes(norm(b)))
  );
}

export function rankScore(p: Posting, profile: SearchProfile, reasons: string[]): number {
  let score = 0;
  // Recency dominates: fresher = higher, unknown date sinks below all dated.
  if (p.age_days !== null) {
    score += (profile.max_age_days - p.age_days) * 10;
    if (p.age_days <= 2) reasons.push("posted in the last 2 days");
  } else {
    score -= 15;
    reasons.push("no post date in feed");
  }
  // Watched companies outrank everything but recency: the user asked to see
  // these whenever a matching role opens.
  const co = norm(`${p.company} ${p.slug}`);
  for (const w of profile.watched_companies ?? []) {
    if (co.includes(norm(w))) {
      score += 20;
      reasons.push(`watched company: ${w}`);
      break;
    }
  }
  const t = norm(p.title);
  for (const s of profile.seniority_terms) {
    if (t.includes(norm(s))) {
      score += 8;
      reasons.push(`seniority: ${s}`);
      break;
    }
  }
  for (const b of profile.boost_terms) {
    if (t.includes(norm(b))) {
      score += 6;
      reasons.push(`domain: ${b}`);
    }
  }
  return score;
}

export interface PrefilterOutput {
  survivors: RankedPosting[];
  stretch: RankedPosting[];
}

export function prefilterAndRank(
  postings: Posting[],
  profile: SearchProfile,
  seenUrls: Set<string>,
  knownApplications: { company: string; role: string }[],
): PrefilterOutput {
  const knownPairs = new Set(knownApplications.map((a) => `${norm(a.company)}|${norm(a.role)}`));
  const byUrl = new Map<string, Posting>();
  for (const p of postings) {
    const key = p.url.split("?")[0];
    if (!byUrl.has(key)) byUrl.set(key, p);
  }

  // Collapse multi-location duplicates of the same role (company+title),
  // preferring a location-matching copy over a stretch copy.
  const byRole = new Map<string, Posting>();
  for (const p of byUrl.values()) {
    const key = `${norm(p.company)}|${norm(p.title)}`;
    const existing = byRole.get(key);
    if (!existing) byRole.set(key, p);
    else if (locationFit(existing, profile) === "stretch" && locationFit(p, profile) === "match") byRole.set(key, p);
  }

  const survivors: RankedPosting[] = [];
  const stretch: RankedPosting[] = [];
  for (const p of byRole.values()) {
    if (seenUrls.has(p.url.split("?")[0])) continue;
    if (knownPairs.has(`${norm(p.company)}|${norm(p.title)}`)) continue;
    if (!passesFunctionGate(p.title, profile)) continue;
    const secondary = inSecondaryLocation(p, profile);
    // User-listed secondary locations (which may be international, e.g. Paris)
    // are exempt from the non-domestic drop; everything else keeps it.
    if (!secondary && isNonUs(p.location)) continue;
    // HARD recency gate: nothing older than the window; unknown dates pass.
    if (p.age_days !== null && p.age_days > profile.max_age_days) continue;
    // Secondary locations carry a HIGHER bar: only strong fits (seniority AND
    // domain signal) surface at all; the rest are dropped, not stretched.
    if (secondary && !locationMatches(p, profile) && !p.remote && !meetsSecondaryBar(p, profile)) continue;

    const reasons: string[] = [];
    const fit = locationFit(p, profile);
    if (secondary && fit === "stretch") reasons.push("secondary location: strong fit");
    const ranked: RankedPosting = { ...p, location_fit: fit, reasons, rank_score: rankScore(p, profile, reasons) };
    (fit === "match" || (secondary && meetsSecondaryBar(p, profile)) ? survivors : stretch).push(ranked);
  }

  const newestFirst = (a: RankedPosting, b: RankedPosting) => b.rank_score - a.rank_score;
  // One company must not flood a run: cap postings per company (best-ranked win).
  const capPerCompany = (list: RankedPosting[], cap: number) => {
    const counts = new Map<string, number>();
    return list.filter((p) => {
      const c = counts.get(p.company) ?? 0;
      if (c >= cap) return false;
      counts.set(p.company, c + 1);
      return true;
    });
  };
  survivors.sort(newestFirst);
  // Stretch only keeps otherwise-strong postings: seniority or domain signal.
  const strongStretch = stretch.filter((p) => p.reasons.some((r) => r.startsWith("seniority") || r.startsWith("domain")));
  strongStretch.sort(newestFirst);
  return { survivors: capPerCompany(survivors, 3), stretch: capPerCompany(strongStretch, 2) };
}
