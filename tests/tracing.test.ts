import { describe, expect, it } from "vitest";
import { appendSpan, summarizeSpans, tracedFinalMessage, type ModelSpan } from "../apps/cloud/lib/tracing";
import { costUsd } from "../apps/cloud/lib/models";

const span = (over: Partial<ModelSpan>): ModelSpan => ({
  at: "2026-08-30T12:00:00Z",
  task: "scoring",
  model: "claude-opus-4-8",
  inputTokens: 1000,
  outputTokens: 500,
  latencyMs: 900,
  costUsd: 0.02,
  ...over,
});

describe("costUsd", () => {
  it("prices a known model per million tokens", () => {
    // 1M in @ $5 + 1M out @ $25
    expect(costUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30);
    expect(costUsd("claude-sonnet-5", 100_000, 10_000)).toBeCloseTo(0.3 + 0.15);
  });
  it("returns null for unknown models rather than guessing", () => {
    expect(costUsd("mystery-model", 1000, 1000)).toBeNull();
  });
});

describe("summarizeSpans", () => {
  it("totals tokens, cost, and per-task breakdown", () => {
    const s = summarizeSpans([
      span({ task: "scoring", costUsd: 0.05 }),
      span({ task: "generation", costUsd: 0.2, inputTokens: 4000, outputTokens: 2000 }),
      span({ task: "generation", costUsd: null }),
    ]);
    expect(s.calls).toBe(3);
    expect(s.inputTokens).toBe(6000);
    expect(s.costUsd).toBeCloseTo(0.25);
    expect(s.byTask.generation.calls).toBe(2);
    expect(s.byTask.generation.costUsd).toBeCloseTo(0.2);
  });
});

describe("appendSpan / tracedFinalMessage", () => {
  const memStore = () => {
    const files = new Map<string, unknown>();
    return {
      files,
      readJson: async <T>(p: string[]) => (files.get(p.join("/")) as T) ?? null,
      writeJson: async (p: string[], v: unknown) => void files.set(p.join("/"), v),
    };
  };

  it("appends into a monthly file and caps its length", async () => {
    const store = memStore();
    await appendSpan(store, span({}));
    await appendSpan(store, span({ task: "generation" }));
    const spans = store.files.get("traces/2026-08.json") as ModelSpan[];
    expect(spans).toHaveLength(2);
  });

  it("traces a streamed call from its usage and never throws on store failure", async () => {
    const store = memStore();
    const message = {
      model: "claude-opus-4-8",
      usage: { input_tokens: 2000, output_tokens: 1000 },
      content: [],
    };
    const out = await tracedFinalMessage(store, "scoring", "app-1", {
      finalMessage: async () => message as never,
    });
    expect(out).toBe(message);
    const spans = store.files.get("traces/2026-08.json") as ModelSpan[];
    expect(spans).toHaveLength(1);
    expect(spans[0].costUsd).toBeCloseTo(costUsd("claude-opus-4-8", 2000, 1000)!);
    expect(spans[0].appId).toBe("app-1");

    // Broken store: the call must still return the message (fail-open).
    const broken = {
      readJson: async () => {
        throw new Error("drive down");
      },
      writeJson: async () => {
        throw new Error("drive down");
      },
    };
    await expect(
      tracedFinalMessage(broken as never, "scoring", undefined, { finalMessage: async () => message as never }),
    ).resolves.toBe(message);
  });
});
