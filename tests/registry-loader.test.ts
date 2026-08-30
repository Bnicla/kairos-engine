import { describe, expect, it } from "vitest";
import { parseRegistry, registryStalenessWarning, resolveRegistry } from "@kairos/engine/sourcing/registry-loader";

const seed = { harvested_at: "2026-08-01T00:00:00Z", entries: [{ ats: "greenhouse" as const, slug: "seedco" }] };

describe("registry loader (REQ-15)", () => {
  it("prefers a valid data copy over the seed", () => {
    const data = { harvested_at: "2026-08-28T00:00:00Z", entries: [{ ats: "ashby", slug: "fresh" }] };
    const r = resolveRegistry(data, seed, new Date("2026-08-30").getTime());
    expect(r.source).toBe("data");
    expect(r.registry.entries[0].slug).toBe("fresh");
    expect(r.staleness).toBeNull();
  });

  it("falls back to the seed on missing or malformed data", () => {
    for (const bad of [null, {}, { entries: [] }, { entries: "nope" }]) {
      const r = resolveRegistry(bad, seed, new Date("2026-08-10").getTime());
      expect(r.source).toBe("seed");
      expect(r.registry.entries[0].slug).toBe("seedco");
    }
  });

  it("warns when the chosen registry is older than 30 days", () => {
    const r = resolveRegistry(null, seed, new Date("2026-09-15").getTime());
    expect(r.staleness).toMatch(/45 days old/);
  });

  it("warns when harvested_at is missing entirely", () => {
    expect(registryStalenessWarning(undefined)).toMatch(/no harvested_at/);
  });

  it("parseRegistry drops entries missing slug or ats", () => {
    const p = parseRegistry({ entries: [{ ats: "ashby", slug: "ok" }, { ats: "ashby" }, { slug: "x" }, null] });
    expect(p?.entries).toHaveLength(1);
  });
});
