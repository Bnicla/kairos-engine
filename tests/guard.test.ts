import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, readJsonCapped, resetRateLimiter } from "../apps/cloud/lib/guard";

describe("rateLimit (REQ-9)", () => {
  beforeEach(() => resetRateLimiter());

  it("allows up to the budget then returns 429", () => {
    for (let i = 0; i < 10; i++) expect(rateLimit("a@x.com")).toBeNull();
    const denied = rateLimit("a@x.com");
    expect(denied?.status).toBe(429);
  });

  it("tracks users independently", () => {
    for (let i = 0; i < 10; i++) rateLimit("a@x.com");
    expect(rateLimit("b@x.com")).toBeNull();
  });
});

describe("readJsonCapped (REQ-9)", () => {
  const mkReq = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/x", { method: "POST", body, headers });

  it("parses a normal body", async () => {
    const r = await readJsonCapped<{ a: number }>(mkReq(JSON.stringify({ a: 1 })));
    expect("body" in r && r.body.a).toBe(1);
  });

  it("rejects an oversized declared content-length with 413", async () => {
    const r = await readJsonCapped(mkReq("{}", { "content-length": String(10 * 1024 * 1024) }));
    expect("error" in r && r.error.status).toBe(413);
  });

  it("rejects an oversized actual body with 413", async () => {
    const r = await readJsonCapped(mkReq(JSON.stringify({ pad: "x".repeat(300 * 1024) })));
    expect("error" in r && r.error.status).toBe(413);
  });

  it("rejects malformed JSON with 400", async () => {
    const r = await readJsonCapped(mkReq("{nope"));
    expect("error" in r && r.error.status).toBe(400);
  });
});
