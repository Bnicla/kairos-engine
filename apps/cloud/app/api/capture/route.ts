import { NextResponse } from "next/server";
import { rateLimit, readJsonCapped } from "../../../lib/guard";
import { getSessionContext, isContextError, getAnthropicKey } from "../../../lib/session";
import { runCaptureTurn } from "../../../lib/capture-agent";
import { ClaudeUserError } from "../../../lib/claude";
import { sseTurnResponse } from "../../../lib/sse";
import type { ChatMessage } from "../../../lib/enrich-agent";

export const dynamic = "force-dynamic";
// Capture + in-turn Opus scoring can take a couple of minutes.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const limited = rateLimit(ctx.email);
  if (limited) return limited;
  const key = await getAnthropicKey(ctx.store);
  if (!key) {
    return NextResponse.json({ error: "Add your Anthropic API key in settings first." }, { status: 400 });
  }

  const parsed = await readJsonCapped<{ messages?: ChatMessage[] }>(req);
  if ("error" in parsed) return parsed.error;
  const body = parsed.body;
  const transcript = (body.messages ?? [])
    .filter(
      (m): m is ChatMessage =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-20);
  if (transcript.length === 0) {
    return NextResponse.json(
      { error: "Share a job ad to get started: a link, a file, or the pasted text." },
      { status: 400 },
    );
  }

  return sseTurnResponse(
    async (emit) =>
      (await runCaptureTurn(key, ctx.store, transcript, emit)) as unknown as Record<string, unknown>,
    (err) =>
      err instanceof ClaudeUserError
        ? { message: err.message }
        : { message: "Something went wrong. Try again.", log: true },
  );
}
