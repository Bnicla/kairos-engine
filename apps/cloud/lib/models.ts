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
