/**
 * Client half of the SSE turn protocol (lib/sse.ts). POSTs the turn, feeds
 * deltas/status to callbacks as they arrive, resolves with the done payload.
 * Non-SSE responses (auth/validation errors) come back as plain JSON.
 */
export async function streamTurn<T>(
  endpoint: string,
  body: unknown,
  handlers: { onDelta?: (text: string) => void; onStatus?: (text: string) => void },
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Something went wrong. Try again.");
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: T | null = null;
  let errorMsg: string | null = null;

  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let payload: { t: string; text?: string; message?: string };
      try {
        payload = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (payload.t === "delta" && payload.text) handlers.onDelta?.(payload.text);
      else if (payload.t === "status" && payload.text) handlers.onStatus?.(payload.text);
      else if (payload.t === "done") done = payload as unknown as T;
      else if (payload.t === "error") errorMsg = payload.message ?? "Something went wrong.";
    }
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!done) throw new Error("The connection dropped mid-reply. Send that again.");
  return done;
}
