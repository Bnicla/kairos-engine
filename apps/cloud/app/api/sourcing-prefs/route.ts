import { NextResponse } from "next/server";
import { getSessionContext, isContextError, getAnthropicKey } from "../../../lib/session";
import { runPrefsTurn } from "../../../lib/prefs-agent";
import type { ChatMessage } from "../../../lib/enrich-agent";
import { ClaudeUserError } from "../../../lib/claude";
import { sseTurnResponse } from "../../../lib/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface PrefsRequest {
  messages: ChatMessage[];
  model?: string;
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const key = await getAnthropicKey(ctx.store);
  if (!key) {
    return NextResponse.json(
      { error: "Add your Anthropic API key in settings first." },
      { status: 400 },
    );
  }
  let body: PrefsRequest;
  try {
    body = (await req.json()) as PrefsRequest;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const transcript = body.messages
    .filter(
      (m): m is ChatMessage =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-40);

  return sseTurnResponse(
    async (emit) =>
      (await runPrefsTurn(key, ctx.store, transcript, body.model, emit)) as unknown as Record<string, unknown>,
    (err) =>
      err instanceof ClaudeUserError
        ? { message: err.message }
        : { message: "Something went wrong. Try again.", log: true },
  );
}
