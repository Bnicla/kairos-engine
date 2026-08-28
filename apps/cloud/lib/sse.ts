/**
 * Minimal SSE plumbing for the chat turns. The stream carries three event
 * shapes: {t:"delta", text} (live assistant text), {t:"status", text} (what a
 * long tool call is doing), and a terminal {t:"done", ...result} or
 * {t:"error", message}. The client renders deltas live, then RECONCILES with
 * the authoritative reply in the done event.
 */

export interface TurnEmit {
  delta: (text: string) => void;
  status: (text: string) => void;
}

export function sseTurnResponse(
  run: (emit: TurnEmit) => Promise<Record<string, unknown>>,
  onError: (err: unknown) => { message: string; log?: boolean },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        const result = await run({
          delta: (text) => send({ t: "delta", text }),
          status: (text) => send({ t: "status", text }),
        });
        send({ t: "done", ...result });
      } catch (err) {
        const mapped = onError(err);
        if (mapped.log) console.error("chat turn failed:", err);
        send({ t: "error", message: mapped.message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
