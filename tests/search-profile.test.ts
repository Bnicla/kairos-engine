import { describe, it, expect } from "vitest";
import { deriveSearchProfile, describeSearchProfile } from "@kairos/engine/sourcing/search-profile";
import { boardFromUrl } from "@kairos/engine/sourcing/sweep";

describe("deriveSearchProfile", () => {
  const fm = {
    target_roles: ["Director of Product", "Head of Product / VP Product", "Principal Product Manager"],
    target_seniority: "Director / Executive / Principal",
    domains: ["Generative AI", "Enterprise SaaS"],
    preferences: { location: "Greater Chicago (IL)" },
    role_shape_preference: "Leaning toward people-management scope.",
  };
  const p = deriveSearchProfile(fm, () => "2026-08-04T00:00:00Z");

  it("derives discipline, seniority, locations and boosts from the candidate profile", () => {
    expect(p.function_terms).toContain("product");
    expect(p.seniority_terms).toEqual(expect.arrayContaining(["principal", "director", "head of", "vp"]));
    expect(p.locations).toContain("greater chicago (il)");
    expect(p.boost_terms).toContain("generative ai");
    expect(p.notes).toMatch(/people-management/);
    expect(p.source).toBe("derived");
  });

  it("falls back to a product default when no discipline is recognizable", () => {
    const empty = deriveSearchProfile({});
    expect(empty.function_terms).toEqual(["product"]);
    expect(empty.max_age_days).toBe(7);
  });

  it("describes the profile in plain language", () => {
    expect(describeSearchProfile(p)).toMatch(/last 7 days/);
    expect(describeSearchProfile(p)).toMatch(/not yet confirmed/);
  });
});

describe("boardFromUrl", () => {
  it("maps public-ATS job URLs to registry entries", () => {
    expect(boardFromUrl("https://job-boards.greenhouse.io/gitlab/jobs/8564957002")).toEqual({
      ats: "greenhouse",
      slug: "gitlab",
    });
    expect(boardFromUrl("https://jobs.ashbyhq.com/docker/ec1eeb85-73bd-4956-bb67-93e0c42958e2")).toEqual({
      ats: "ashby",
      slug: "docker",
    });
    expect(boardFromUrl("https://ats.rippling.com/useorigin/jobs/a41a2afe")).toEqual({
      ats: "rippling",
      slug: "useorigin",
    });
    expect(boardFromUrl("https://jobs.fidelity.com/en/jobs/2127874/")).toBeNull();
    expect(boardFromUrl(undefined)).toBeNull();
  });
});
