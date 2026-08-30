import type Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "./models";

/**
 * Model-call tracing: one span per call — task, model, tokens, dollars,
 * latency — appended to the user's own store under traces/<YYYY-MM>.json
 * (their data, their Drive; DEC-5 keeps nothing server-side). Fail-open by
 * contract: a tracing failure must never break the product call.
 *
 * Scope note, stated honestly: this instruments the CLOUD lane's SDK calls,
 * where token usage is reported. The local lane reasons through the Claude
 * Code CLI (Max-billed), which does not expose per-call usage — those calls
 * are deliberately not traced rather than estimated.
 */

export interface ModelSpan {
  at: string;
  task: string;
  model: string;
  appId?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number | null;
}

interface SpanStore {
  readJson<T>(path: string[]): Promise<T | null>;
  writeJson(path: string[], value: unknown): Promise<unknown>;
}

export async function appendSpan(store: SpanStore, span: ModelSpan): Promise<void> {
  try {
    const path = ["traces", `${span.at.slice(0, 7)}.json`];
    const existing = (await store.readJson<ModelSpan[]>(path)) ?? [];
    existing.push(span);
    await store.writeJson(path, existing.slice(-2000));
  } catch {
    /* fail-open */
  }
}

/** Aggregate spans for reporting (pure; used by the cost runner and tests). */
export function summarizeSpans(spans: ModelSpan[]): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  byTask: Record<string, { calls: number; costUsd: number }>;
} {
  const byTask: Record<string, { calls: number; costUsd: number }> = {};
  let input = 0, output = 0, cost = 0;
  for (const s of spans) {
    input += s.inputTokens;
    output += s.outputTokens;
    cost += s.costUsd ?? 0;
    const t = (byTask[s.task] ??= { calls: 0, costUsd: 0 });
    t.calls += 1;
    t.costUsd += s.costUsd ?? 0;
  }
  return { calls: spans.length, inputTokens: input, outputTokens: output, costUsd: cost, byTask };
}

/**
 * Run a streamed model call and trace it: times the call, reads usage off the
 * final message, computes cost from the price table, appends the span.
 */
export async function tracedFinalMessage(
  store: SpanStore | null,
  task: string,
  appId: string | undefined,
  stream: { finalMessage(): Promise<Anthropic.Message> },
): Promise<Anthropic.Message> {
  const started = Date.now();
  const message = await stream.finalMessage();
  if (store) {
    const usage = message.usage ?? { input_tokens: 0, output_tokens: 0 };
    await appendSpan(store, {
      at: new Date().toISOString(),
      task,
      model: message.model,
      appId,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      latencyMs: Date.now() - started,
      costUsd: costUsd(message.model, usage.input_tokens ?? 0, usage.output_tokens ?? 0),
    });
  }
  return message;
}
