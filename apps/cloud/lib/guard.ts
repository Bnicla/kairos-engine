import { NextResponse } from "next/server";

/**
 * Abuse limits for the agent routes (REQ-9). These routes run multi-turn model
 * loops on the STUDENT'S OWN key — a buggy or hostile client can burn their
 * credits and hammer shared Drive quota fast. Two cheap server-side guards:
 *
 *  - a JSON body size cap, enforced before parsing;
 *  - an in-memory per-user sliding-window rate limit.
 *
 * The rate limit is per server instance (no shared store by design, DEC-5);
 * that is an accepted limitation at current scale — it stops runaway loops,
 * not distributed abuse.
 */

export const MAX_BODY_BYTES = 256 * 1024;

/** Parse the JSON body with a hard size cap. Returns a 4xx response on violation. */
export async function readJsonCapped<T>(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ body: T } | { error: Response }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: NextResponse.json({ error: "Request too large." }, { status: 413 }) };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: NextResponse.json({ error: "Bad request." }, { status: 400 }) };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { error: NextResponse.json({ error: "Request too large." }, { status: 413 }) };
  }
  try {
    return { body: JSON.parse(text) as T };
  } catch {
    return { error: NextResponse.json({ error: "Bad request." }, { status: 400 }) };
  }
}

const WINDOW_MS = 60_000;
const MAX_TURNS_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter keyed by user email. Returns a 429 response when the
 * user exceeds the budget, null when the request may proceed.
 */
export function rateLimit(userKey: string, max = MAX_TURNS_PER_WINDOW): Response | null {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const recent = (hits.get(userKey) ?? []).filter((t) => t > windowStart);
  if (recent.length >= max) {
    hits.set(userKey, recent);
    return NextResponse.json(
      { error: "You're moving fast — give it a minute and try again (this protects your API credits)." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  recent.push(now);
  hits.set(userKey, recent);
  // Opportunistic cleanup so the map cannot grow unbounded.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (v.every((t) => t <= windowStart)) hits.delete(k);
  }
  return null;
}

/** Test hook. */
export function resetRateLimiter(): void {
  hits.clear();
}
