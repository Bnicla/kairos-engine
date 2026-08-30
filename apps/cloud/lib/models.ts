/**
 * The models a student may pick for interactive flows, with honest tradeoffs.
 * They pay Anthropic directly (BYO key), so the choice is theirs — we curate
 * three points on the speed/cost/quality curve instead of a raw model list.
 */

export interface ModelOption {
  id: string;
  label: string;
  /** Short tradeoff line shown in the picker. */
  blurb: string;
  /** Whether the model supports adaptive thinking (pre-4.6 models don't). */
  adaptiveThinking: boolean;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5 · quick",
    blurb: "Fastest answers · under 1¢ per interview · lighter questions",
    adaptiveThinking: false,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5 · balanced",
    blurb: "Fast · ~1–3¢ per interview · sharp questions (recommended)",
    adaptiveThinking: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8 · deep",
    blurb: "Slower · ~5–10¢ per interview · the sharpest follow-ups",
    adaptiveThinking: true,
  },
];

export const DEFAULT_MODEL = "claude-sonnet-5";

export function resolveModel(id: unknown): ModelOption {
  return MODEL_OPTIONS.find((m) => m.id === id) ?? MODEL_OPTIONS.find((m) => m.id === DEFAULT_MODEL)!;
}

/**
 * Per-task defaults (REQ-10): the ONE registry for every model id and its
 * token/thinking settings. No model id string literals belong anywhere else —
 * drift between call sites and the picker is how billing surprises happen.
 * Quality-load-bearing tasks (extraction, scoring, generation, letters) run on
 * Opus regardless of the interactive picker; chat-style flows default cheaper.
 */
export interface TaskModel {
  id: string;
  maxTokens: number;
  adaptiveThinking: boolean;
}

/**
 * List prices per million tokens (USD), for cost tracing. Prices drift —
 * `asOf` is part of the data, and spans store computed cost at call time so
 * historical spans stay honest even after a price change.
 */
export const MODEL_PRICES: Record<string, { inPerM: number; outPerM: number; asOf: string }> = {
  "claude-opus-4-8": { inPerM: 5, outPerM: 25, asOf: "2026-08-30" },
  "claude-sonnet-5": { inPerM: 3, outPerM: 15, asOf: "2026-08-30" },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5, asOf: "2026-08-30" },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

export const TASK_MODELS = {
  /** Résumé-PDF → knowledge-base extraction (long output, quality-critical). */
  extraction: { id: "claude-opus-4-8", maxTokens: 32_000, adaptiveThinking: true },
  /** Honest scoring + résumé/letter generation (guarded save paths). */
  scoring: { id: "claude-opus-4-8", maxTokens: 24_000, adaptiveThinking: true },
  /** Job-ad capture chat (tool loop; speed matters more than depth). */
  capture: { id: "claude-sonnet-5", maxTokens: 8_000, adaptiveThinking: true },
} as const satisfies Record<string, TaskModel>;
