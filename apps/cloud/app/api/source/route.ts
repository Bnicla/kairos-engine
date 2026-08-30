import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { rateLimit, readJsonCapped } from "../../../lib/guard";
import { getSessionContext, isContextError, getAnthropicKey } from "../../../lib/session";
import { resolveModel } from "../../../lib/models";
import { getOrDeriveSearchProfile } from "../../../lib/prefs-agent";
import { runSourcingSweep } from "@kairos/engine/sourcing/sweep";
import { loadIndexHealed } from "@kairos/engine/applications";
import type { RegistryEntry } from "@kairos/engine/sourcing/types";
import registrySeed from "@kairos/engine/sourcing/registry.json";
import { resolveRegistry, type RegistryFile } from "@kairos/engine/sourcing/registry-loader";

export const dynamic = "force-dynamic";
// A full sweep is thousands of board fetches plus one triage call.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const limited = rateLimit(ctx.email);
  if (limited) return limited;
  const key = await getAnthropicKey(ctx.store);
  if (!key) {
    return NextResponse.json(
      { error: "Add your Anthropic API key in settings first — triage runs on it." },
      { status: 400 },
    );
  }

  let model: string | undefined;
  {
    // Tolerates an empty/absent body (legacy behavior) but still enforces the
    // size cap: only a 413 short-circuits.
    const parsed = await readJsonCapped<{ model?: string }>(req);
    if ("error" in parsed) {
      if (parsed.error.status === 413) return parsed.error;
    } else {
      model = parsed.body.model;
    }
  }

  const [profile, index, seenFile, profileRaw] = await Promise.all([
    getOrDeriveSearchProfile(ctx.store),
    loadIndexHealed(ctx.store),
    ctx.store.readJson<Record<string, unknown>>(["sourcing", "seen.json"]),
    ctx.store.readFile(["profile.md"]),
  ]);
  const seenUrls = new Set<string>(Object.keys(seenFile ?? {}));
  const registryData = await ctx.store.readJson<unknown>(["sourcing", "registry.json"]).catch(() => null);
  const registryResolved = resolveRegistry(registryData, registrySeed as unknown as RegistryFile);
  if (registryResolved.staleness) console.warn("[source] " + registryResolved.staleness);
  let profileSummary = (profileRaw ?? "").slice(0, 1500);
  if (profile.notes) profileSummary += `\n\nSourcing notes: ${profile.notes}`;

  const result = await runSourcingSweep({
    registry: registryResolved.registry.entries,
    profile,
    seenUrls,
    knownApplications: index.applications.map((a) => ({ company: a.company, role: a.role })),
    profileSummary,
    triage: async (prompt) => {
      const m = resolveModel(model);
      const client = new Anthropic({ apiKey: key });
      const res = await client.messages.create({
        model: m.id,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      });
      return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    },
  });

  await ctx.store.writeJson(["sourcing", "last-run.json"], result);
  return NextResponse.json({
    ok: true,
    survivors: result.survivors.length,
    stretch: result.stretch.length,
    postings: result.postings_fetched,
    triaged: result.triaged,
  });
}
