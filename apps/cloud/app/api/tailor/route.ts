import { NextResponse } from "next/server";
import { getSessionContext, isContextError, getAnthropicKey } from "../../../lib/session";
import { runTailorTurn } from "../../../lib/tailor-agent";
import { ClaudeUserError } from "../../../lib/claude";
import { sseTurnResponse } from "../../../lib/sse";
import type { ChatMessage } from "../../../lib/enrich-agent";

export const dynamic = "force-dynamic";
// A turn may include an in-turn Opus rescore.
export const maxDuration = 300;

interface TailorRequest {
  appId: string;
  messages: ChatMessage[];
  model?: string;
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await getSessionContext();
  if (isContextError(ctx)) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const key = await getAnthropicKey(ctx.store);
  if (!key) {
    return NextResponse.json({ error: "Add your Anthropic API key in settings first." }, { status: 400 });
  }

  let body: TailorRequest;
  try {
    body = (await req.json()) as TailorRequest;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  if (typeof body.appId !== "string" || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const transcript = body.messages
    .filter(
      (m): m is ChatMessage =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-60);

  const appId = body.appId;
  const model = body.model;
  return sseTurnResponse(
    async (emit) =>
      (await runTailorTurn(key, ctx.store, appId, transcript, model, emit)) as unknown as Record<string, unknown>,
    (err) =>
      err instanceof ClaudeUserError
        ? { message: err.message }
        : { message: "Something went wrong. Try again.", log: true },
  );
}
