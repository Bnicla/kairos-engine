import { NextResponse } from "next/server";
import { rateLimit, readJsonCapped } from "../../../lib/guard";
import { getSessionContext, isContextError, getAnthropicKey } from "../../../lib/session";
import { runEnrichmentTurn, type ChatMessage } from "../../../lib/enrich-agent";
import { ClaudeUserError } from "../../../lib/claude";
import { sseTurnResponse } from "../../../lib/sse";

export const dynamic = "force-dynamic";
// One turn can span several tool-use iterations; give it room on Vercel.
export const maxDuration = 300;

interface EnrichRequest {
  fileName: string;
  messages: ChatMessage[];
  model?: string;
}

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
      { error: "Add your Anthropic API key in settings first." },
      { status: 400 },
    );
  }

  const parsed = await readJsonCapped<EnrichRequest>(req);
  if ("error" in parsed) return parsed.error;
  const body = parsed.body;
  if (typeof body.fileName !== "string" || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const transcript = body.messages
    .filter(
      (m): m is ChatMessage =>
        !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-40);

  const fileName = body.fileName;
  const model = body.model;
  return sseTurnResponse(
    async (emit) =>
      (await runEnrichmentTurn(key, ctx.store, fileName, transcript, model, emit)) as unknown as Record<string, unknown>,
    (err) =>
      err instanceof ClaudeUserError
        ? { message: err.message }
        : { message: "Something went wrong. Try again.", log: true },
  );
}
