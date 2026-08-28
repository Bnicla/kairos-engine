import Anthropic from "@anthropic-ai/sdk";
import matter from "gray-matter";
import type { DriveStore } from "../store/drive";
import { resolveModel } from "./models";
import { ClaudeUserError } from "./claude";
import type { TurnEmit } from "./sse";
import type { ChatMessage } from "./enrich-agent";
import {
  SOURCING_PREFS_SYSTEM_PROMPT,
  buildSourcingPrefsUserMessage,
} from "@kairos/engine/prompts/sourcing-prefs";
import {
  deriveSearchProfile,
  describeSearchProfile,
  loadSearchProfile,
  saveSearchProfile,
  type CandidateProfileFrontmatter,
  type StoredSearchProfile,
} from "@kairos/engine/sourcing/search-profile";

/**
 * The sourcing-preferences conversation (cloud lane). Same stateless-turn
 * pattern as enrichment: browser holds the transcript, each turn rebuilds
 * context, the save tool writes sourcing/search-profile.json to THEIR Drive.
 */

export interface PrefsTurnResult {
  reply: string;
  profileDescription: string | null;
}

const SAVE_TOOL: Anthropic.Tool = {
  name: "save_search_profile",
  description:
    "Persist the user's complete sourcing preferences after they confirm a change. Pass ALL fields, not just the changed one. Never save preferences the user did not state.",
  input_schema: {
    type: "object",
    properties: {
      function_terms: { type: "array", items: { type: "string" } },
      exclude_terms: { type: "array", items: { type: "string" } },
      locations: { type: "array", items: { type: "string" } },
      secondary_locations: { type: "array", items: { type: "string" } },
      boost_terms: { type: "array", items: { type: "string" } },
      seniority_terms: { type: "array", items: { type: "string" } },
      max_age_days: { type: "integer", minimum: 1, maximum: 60 },
      international_ok: { type: "boolean" },
      notes: { type: "string" },
      source: { type: "string", enum: ["derived", "confirmed"] },
    },
    required: [
      "function_terms", "exclude_terms", "locations", "boost_terms",
      "seniority_terms", "max_age_days", "source",
    ],
  },
};

export async function getOrDeriveSearchProfile(store: DriveStore): Promise<StoredSearchProfile> {
  const existing = await loadSearchProfile(store);
  if (existing) return existing;
  const profileRaw = await store.readFile(["profile.md"]);
  const fm = profileRaw ? (matter(profileRaw).data as CandidateProfileFrontmatter) : {};
  const derived = deriveSearchProfile(fm);
  await saveSearchProfile(store, derived);
  return derived;
}

export async function runPrefsTurn(
  apiKey: string,
  store: DriveStore,
  transcript: ChatMessage[],
  modelId?: string,
  emit?: Partial<TurnEmit>,
): Promise<PrefsTurnResult> {
  const [profile, profileRaw] = await Promise.all([
    getOrDeriveSearchProfile(store),
    store.readFile(["profile.md"]),
  ]);
  const candidateSummary = (profileRaw ?? "").slice(0, 1200);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildSourcingPrefsUserMessage({ currentProfile: profile, candidateSummary }) },
    ...transcript.map((m) => ({ role: m.role, content: m.content })),
  ];

  const model = resolveModel(modelId);
  const client = new Anthropic({ apiKey });
  const replyParts: string[] = [];
  let savedDescription: string | null = null;

  try {
    for (let i = 0; i < 5; i++) {
      const stream = client.messages.stream({
        model: model.id,
        max_tokens: 8000,
        ...(model.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
        system: SOURCING_PREFS_SYSTEM_PROMPT,
        tools: [SAVE_TOOL],
        messages,
      });
      if (emit?.delta) {
        if (replyParts.length > 0) emit.delta("\n\n");
        stream.on("text", (d) => emit.delta!(d));
      }
      const response = await stream.finalMessage();
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) replyParts.push(block.text.trim());
      }
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const next = {
          ...(tu.input as Omit<StoredSearchProfile, "updated_at">),
          updated_at: new Date().toISOString(),
        } as StoredSearchProfile;
        await saveSearchProfile(store, next);
        savedDescription = describeSearchProfile(next);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Preferences saved to their Drive.",
        });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ClaudeUserError("Your Anthropic API key was rejected. Replace it in settings.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ClaudeUserError("Anthropic rate limit hit on your key. Wait a minute and retry.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeUserError(`Claude call failed (${err.status ?? "network"}). Try again.`);
    }
    throw err;
  }

  return { reply: replyParts.join("\n\n"), profileDescription: savedDescription };
}
