import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoardDetailed } from "@kairos/engine/sourcing/adapters";
import type { RegistryEntry } from "@kairos/engine/sourcing/types";

const gh: RegistryEntry = { ats: "greenhouse", slug: "acme" };

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("fetchBoardDetailed (REQ-6 — typed outcomes, retry, loud failures)", () => {
  it("returns postings on a healthy board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ jobs: [{ title: "PM", absolute_url: "https://x/1", location: { name: "Boston" } }] }),
    ));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0].title).toBe("PM");
  });

  it("retries once on 429 and succeeds (honoring Retry-After)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429, { "retry-after": "0.001" }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ title: "PM", absolute_url: "https://x/1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBoardDetailed(gh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.failure).toBeUndefined();
    expect(r.postings).toHaveLength(1);
  });

  it("reports rate_limited when the retry also 429s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429, { "retry-after": "0.001" })));
    const r = await fetchBoardDetailed(gh);
    expect(r.postings).toEqual([]);
    expect(r.failure?.kind).toBe("rate_limited");
    expect(r.failure?.status).toBe(429);
  });

  it("classifies 404 as gone (registry decay, not infrastructure failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("gone");
  });

  it("classifies persistent 5xx as http failure after one retry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503, { "retry-after": "0.001" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchBoardDetailed(gh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.failure?.kind).toBe("http");
    expect(r.failure?.status).toBe(503);
  });

  it("classifies invalid JSON as parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 200 })));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("parse");
  });

  it("classifies thrown fetch errors as network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const r = await fetchBoardDetailed(gh);
    expect(r.failure?.kind).toBe("network");
  });
});
