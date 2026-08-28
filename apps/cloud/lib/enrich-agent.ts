import Anthropic from "@anthropic-ai/sdk";
import type { DriveStore } from "../store/drive";
import { saveExperience } from "@kairos/engine/kb/store";
import {
  insertUnderSection,
  parseExperience,
  serializeExperience,
} from "@kairos/engine/kb/experience";
import { resolveModel } from "./models";
import {
  ENRICHMENT_SYSTEM_PROMPT,
  buildEnrichmentUserMessage,
} from "@kairos/engine/prompts/enrichment";
import { ClaudeUserError } from "./claude";
import { refreshHealth } from "./health-refresh";
import type { TurnEmit } from "./sse";

/**
 * One enrichment interview turn — the first live slice of the cloud agent loop.
 * Stateless server side (DEC-5): the browser holds the transcript and sends it
 * whole each turn; we rebuild context, run the tool-use loop on the STUDENT'S
 * key, execute save_confirmed_fact against their Drive, and return the reply.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EnrichTurnResult {
  reply: string;
  saved: { section: string; content: string }[];
  healthOverall: number | null;
}

const CHAT_ADDENDUM = `

LIVE INTERVIEW MODE (overrides the numbered-list output rule): you are chatting with the candidate directly.
- Ask ONE question at a time, conversationally. Wait for the answer before the next.
- When an answer contains a real fact, story, metric, or context, store it with the save_confirmed_fact tool, in the candidate's own words, condensed but never embellished. One call per distinct fact. Then briefly acknowledge and ask the next question.
- If an answer is vague, ask one sharp follow-up before storing anything.
- Never store speculation, hedges ("maybe", "I think around..." without a number they commit to), or anything the candidate did not actually say.
- After 6-8 answered questions, or when the candidate wants to stop, close: one short recap of what was captured, no flattery.
- Tone throughout: warm and encouraging without flattery; acknowledge each answer before the next question. Short does not mean curt.`;

const SAVE_TOOL: Anthropic.Tool = {
  name: "save_confirmed_fact",
  description:
    "Store one fact the candidate just told you into this experience, tagged [C] (confirmed). Call it only with what the candidate actually said, never inferred or embellished material.",
  input_schema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: ["Context & mandate", "Deeper detail", "Stories", "Skills note"],
        description: "Which section of the experience file the fact belongs under",
      },
      content: {
        type: "string",
        description:
          "The fact/story as a markdown bullet or short paragraph, in the candidate's words",
      },
    },
    required: ["section", "content"],
  },
};

export async function runEnrichmentTurn(
  apiKey: string,
  store: DriveStore,
  fileName: string,
  transcript: ChatMessage[],
  modelId?: string,
  emit?: Partial<TurnEmit>,
): Promise<EnrichTurnResult> {
  // Read just the one file being enriched — loading the whole KB per turn was
  // most of the perceived latency (7+ sequential Drive reads).
  const raw = await store.readFile(["knowledge-base", "experiences", fileName]);
  if (!raw) throw new ClaudeUserError("That role no longer exists in your knowledge base.");
  const exp = parseExperience(fileName, raw);

  // Deliberate exception to the stripUnverified rule (same as the local lane):
  // enrichment sends the full file including the [?] pen, because its whole job
  // is confirming that material. The prompt produces questions, never facts.
  const context = `${buildEnrichmentUserMessage({
    experienceMarkdown: serializeExperience(exp),
    targetRoles: [],
  })}\n\n(You are now live with the candidate. Greet them in one line and ask your first question.)`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: context },
    ...transcript.map((m) => ({ role: m.role, content: m.content })),
  ];

  const model = resolveModel(modelId);
  const client = new Anthropic({ apiKey });
  const saved: EnrichTurnResult["saved"] = [];
  const replyParts: string[] = [];

  try {
    for (let i = 0; i < 6; i++) {
      const stream = client.messages.stream({
        model: model.id,
        max_tokens: 16000,
        // Pre-4.6 models (Haiku 4.5) reject adaptive thinking — omit for them.
        ...(model.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
        system: ENRICHMENT_SYSTEM_PROMPT + CHAT_ADDENDUM,
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
        const input = tu.input as { section: string; content: string };
        exp.body = insertUnderSection(exp.body, input.section, input.content);
        await saveExperience(store, exp);
        saved.push({ section: input.section, content: input.content });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Saved under "${input.section}", tagged [C].`,
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

  let healthOverall: number | null = null;
  if (saved.length > 0) {
    healthOverall = (await refreshHealth(store)).overall;
  }

  return { reply: replyParts.join("\n\n"), saved, healthOverall };
}
