import { describe, it, expect } from "vitest";
import { prefilterAndRank } from "@kairos/engine/sourcing/filter";
import { parseWorkdayPostedOn } from "@kairos/engine/sourcing/adapters";
import type { Posting, SearchProfile } from "@kairos/engine/sourcing/types";

const NOW = new Date("2026-07-28T12:00:00Z").getTime();

const profile: SearchProfile = {
  function_terms: ["product"],
  exclude_terms: ["intern", "engineer"],
  locations: ["boston", "united states"],
  boost_terms: ["ai"],
  seniority_terms: ["principal", "staff"],
  max_age_days: 7,
};

const posting = (over: Partial<Posting>): Posting => ({
  ats: "greenhouse",
  slug: "acme",
  company: "Acme",
  title: "Product Manager",
  url: `https://boards.greenhouse.io/acme/jobs/${Math.abs(JSON.stringify(over).length)}${over.title ?? ""}`,
  location: "Remote",
  remote: true,
  posted_at: new Date(NOW - 2 * 86_400_000).toISOString(),
  age_days: 2,
  ...over,
});

describe("sourcing prefilter + rank", () => {
  it("enforces the hard 7-day recency gate but keeps unknown dates (ranked last)", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead Fresh", age_days: 1 }),
        posting({ title: "Product Lead Stale", age_days: 9 }),
        posting({ title: "Product Lead Undated", posted_at: null, age_days: null }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors.map((s) => s.title)).toEqual(["Product Lead Fresh", "Product Lead Undated"]);
  });

  it("ranks newer first, seniority and domain boost within the window", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Manager Old", age_days: 6 }),
        posting({ title: "Principal Product Manager, AI Today", age_days: 0 }),
        posting({ title: "Product Manager Today", age_days: 0 }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors[0].title).toBe("Principal Product Manager, AI Today");
    expect(survivors[1].title).toBe("Product Manager Today");
    expect(survivors[2].title).toBe("Product Manager Old");
  });

  it("gates on function only — plain 'Product Manager' passes (Suno lesson)", () => {
    const { survivors } = prefilterAndRank([posting({ title: "Product Manager, ML Research" })], profile, new Set(), []);
    expect(survivors).toHaveLength(1);
  });

  it("routes strong non-local postings to stretch instead of dropping (Rippling lesson)", () => {
    const { survivors, stretch } = prefilterAndRank(
      [posting({ title: "Staff Product Manager", location: "San Francisco", remote: false })],
      profile,
      new Set(),
      [],
    );
    expect(survivors).toHaveLength(0);
    expect(stretch.map((s) => s.title)).toEqual(["Staff Product Manager"]);
  });

  it("dedupes against existing applications and seen urls, excludes noise titles", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead, AI", company: "Stripe" }),
        posting({ title: "Product Engineer" }),
        posting({ title: "Product Person Seen", url: "https://x.co/seen?utm=1" }),
      ],
      profile,
      new Set(["https://x.co/seen"]),
      [{ company: "Stripe", role: "Product Lead, AI" }],
    );
    expect(survivors).toHaveLength(0);
  });
});

describe("workday postedOn parsing", () => {
  it("parses the phrase formats", () => {
    expect(parseWorkdayPostedOn("Posted Today", NOW)).toBe(new Date(NOW).toISOString());
    expect(parseWorkdayPostedOn("Posted Yesterday", NOW)).toBe(new Date(NOW - 86_400_000).toISOString());
    expect(parseWorkdayPostedOn("Posted 6 Days Ago", NOW)).toBe(new Date(NOW - 6 * 86_400_000).toISOString());
    expect(parseWorkdayPostedOn("Posted 30+ Days Ago", NOW)).toBe(new Date(NOW - 31 * 86_400_000).toISOString());
    expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
  });
});

describe("2026-07-28 first-run fixes", () => {
  it("word-boundary gate: 'Production Technician' does not match 'product'", () => {
    const { survivors, stretch } = prefilterAndRank(
      [posting({ title: "Lead Production Technician, Intelligence Systems" })],
      profile,
      new Set(),
      [],
    );
    expect(survivors).toHaveLength(0);
    expect(stretch).toHaveLength(0);
  });

  it("drops clearly non-US postings even when flagged remote", () => {
    const { survivors } = prefilterAndRank(
      [
        posting({ title: "Product Lead A", location: "Germany", remote: true, url: "https://x.co/de" }),
        posting({ title: "Product Lead B", location: "Remote - United States", remote: true, url: "https://x.co/us" }),
      ],
      profile,
      new Set(),
      [],
    );
    expect(survivors.map((s) => s.title)).toEqual(["Product Lead B"]);
  });

  it("collapses multi-location duplicates and caps per-company flooding", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      posting({
        title: i < 6 ? "Product Lead - AI App" : `Product Lead Unique ${i}`,
        company: "Flood",
        url: `https://x.co/flood/${i}`,
        location: "Remote - United States",
      }),
    );
    const { survivors } = prefilterAndRank(many, profile, new Set(), []);
    expect(survivors.filter((s) => s.company === "Flood")).toHaveLength(3);
    expect(survivors.filter((s) => s.title === "Product Lead - AI App")).toHaveLength(1);
  });
});

describe("triage", () => {
  it("parses verdicts, ignores unknown urls, applies band ordering and cap", async () => {
    const { parseTriageResponse, applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", url: "https://x.co/a" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", url: "https://x.co/b" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const c = { ...posting({ title: "Product C", url: "https://x.co/c" }), rank_score: 70, location_fit: "match" as const, reasons: [] };
    const text = `Here you go:\n[
      {"url":"https://x.co/a","verdict":"SHORTLIST","guess_band":"STRONG","one_liner":"fits"},
      {"url":"https://x.co/b","verdict":"SHORTLIST","guess_band":"COMPETITIVE","one_liner":"ok"},
      {"url":"https://x.co/c","verdict":"SKIP"},
      {"url":"https://x.co/unknown","verdict":"SHORTLIST"}
    ]`;
    const verdicts = parseTriageResponse(text, new Set(["https://x.co/a", "https://x.co/b", "https://x.co/c"]));
    expect(verdicts.size).toBe(3);
    const { list, triaged } = applyTriage([a, b, c], verdicts, 10);
    expect(triaged).toBe(true);
    // a and b share a company; only the better-banded one represents it.
    expect(list.map((p) => p.title)).toEqual(["Product A"]);
    expect(list[0].guess_band).toBe("STRONG");
  });

  it("falls back to deterministic top-N when triage is unavailable", async () => {
    const { applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", url: "https://x.co/a" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", url: "https://x.co/b" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const { list, triaged } = applyTriage([b, a], new Map(), 1);
    expect(triaged).toBe(false);
    expect(list.map((p) => p.title)).toEqual(["Product B"]);
  });
});

describe("one job per company in the final shortlist", () => {
  it("keeps only the best-ranked shortlisted posting per company", async () => {
    const { parseTriageResponse, applyTriage } = await import("@kairos/engine/sourcing/triage");
    const a = { ...posting({ title: "Product A", company: "Livekit", url: "https://x.co/a" }), rank_score: 90, location_fit: "match" as const, reasons: [] };
    const b = { ...posting({ title: "Product B", company: "Livekit", url: "https://x.co/b" }), rank_score: 50, location_fit: "match" as const, reasons: [] };
    const c = { ...posting({ title: "Product C", company: "Other", url: "https://x.co/c" }), rank_score: 10, location_fit: "match" as const, reasons: [] };
    const verdicts = parseTriageResponse(
      `[{"url":"https://x.co/a","verdict":"SHORTLIST","guess_band":"STRONG"},
        {"url":"https://x.co/b","verdict":"SHORTLIST","guess_band":"STRONG"},
        {"url":"https://x.co/c","verdict":"SHORTLIST","guess_band":"COMPETITIVE"}]`,
      new Set(["https://x.co/a", "https://x.co/b", "https://x.co/c"]),
    );
    const { list } = applyTriage([a, b, c], verdicts, 10);
    expect(list.map((p) => p.title)).toEqual(["Product A", "Product C"]);
  });
});

describe("secondary locations (higher bar)", () => {
  const secondaryProfile: SearchProfile = {
    ...profile,
    secondary_locations: ["san francisco", "paris"],
  };
  const mk = (over: Partial<Posting>): Posting => ({
    ats: "greenhouse", slug: "x", company: "X", title: "Principal Product Manager, AI",
    url: `https://job-boards.greenhouse.io/x/jobs/${Math.floor(Math.random() * 1e9)}`,
    location: "San Francisco, CA", remote: false, posted_at: new Date(NOW - 86400000).toISOString(),
    age_days: 1, ...over,
  });

  it("surfaces strong fits in secondary locations as survivors", () => {
    const out = prefilterAndRank([mk({})], secondaryProfile, new Set(), []);
    expect(out.survivors).toHaveLength(1);
    expect(out.survivors[0].reasons).toContain("secondary location: strong fit");
  });

  it("drops weak fits in secondary locations entirely (not stretch)", () => {
    const weak = mk({ title: "Product Manager, Payments", url: "https://job-boards.greenhouse.io/x/jobs/2" });
    const out = prefilterAndRank([weak], secondaryProfile, new Set(), []);
    expect(out.survivors).toHaveLength(0);
    expect(out.stretch).toHaveLength(0);
  });

  it("exempts listed international cities from the non-US drop, still applying the bar", () => {
    const paris = mk({ location: "Paris, France", url: "https://job-boards.greenhouse.io/x/jobs/3" });
    const parisWeak = mk({ title: "Product Manager", location: "Paris, France", url: "https://job-boards.greenhouse.io/x/jobs/4" });
    const out = prefilterAndRank([paris, parisWeak], secondaryProfile, new Set(), []);
    expect(out.survivors.map((p) => p.url)).toEqual(["https://job-boards.greenhouse.io/x/jobs/3"]);
  });

  it("keeps unlisted non-US locations dropped", () => {
    const berlin = mk({ location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/x/jobs/5" });
    const out = prefilterAndRank([berlin], secondaryProfile, new Set(), []);
    expect(out.survivors.length + out.stretch.length).toBe(0);
  });
});
