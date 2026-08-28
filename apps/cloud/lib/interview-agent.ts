import Anthropic from "@anthropic-ai/sdk";
import type { DriveStore } from "../store/drive";
import { readMeta, readScoreReport, readSnapshot } from "@kairos/engine/applications";
import { loadExperiences } from "@kairos/engine/kb/store";
import { serializeExperience } from "@kairos/engine/kb/experience";
import { loadQAIndex, readQA, upsertQA } from "@kairos/engine/qabank";
import type { ScoreReport } from "@kairos/engine/types";
import { ClaudeUserError, toUserError } from "./claude";
import { resolveModel } from "./models";
import type { ChatMessage } from "./enrich-agent";
import type { TurnEmit } from "./sse";

/**
 * Interview prep conversation for one application (ongoing stage). Implements
 * the prep framework: company-in-60-seconds (live web search on the student's
 * key), strongest cards mapped JD-phrase to KB-story, gaps named honestly,
 * the interviewer's evaluation tells decoded from the ad, did-the-reading
 * questions — then scenario/mock coaching. Transcript persists per application.
 */

export interface PrepTurnResult {
  reply: string;
  answersSaved: string[];
}

const SYSTEM = `You are Kairos's interview prep coach for ONE specific job application, inside an authenticity-preserving career tool. The candidate has an interview coming up. Your material: the job ad, their honest fit score, their full knowledge base (all real, provenance-tagged facts), and their banked answers. You never invent facts about the candidate and never coach them to stretch the truth. Their real experience, sharpened, is the whole strategy.

FIRST TURN: greet in one line, then ask ONE question: to paste the interview invite (format, interviewer names, anything the recruiter said) or reply "skip". Do not produce the brief yet.

WHEN THEY ANSWER (or skip), produce the PREP BRIEF in this exact structure, tight and scannable:
1. **Company in 60 seconds**: what they do, key numbers, and RECENT momentum. Use web_search for news from the last 6 months (funding, launches, leadership, competitive moves). 1-2 searches, no more.
2. **Your strongest cards** (3): map the ad's own phrases to the candidate's specific KB stories with their real metrics. The best card is the one where their evidence IS the company's problem.
3. **The gap, handled honestly**: name the biggest real gap and the truthful bridge. Never suggest claiming what the KB does not hold.
4. **What they're actually evaluating**: decode the ad's and invite's language into the interviewer's real tests, with the one behavior that passes each.
5. **Ask them** (3 questions): specific to this company's current moment, showing the candidate did the reading.

THEN offer next steps, one at a time as the candidate chooses: rehearse likely questions (ask one, listen, give sharp feedback grounded in KB facts, suggest the stronger version), walk a product-scenario framework if the interview is scenario-based, or tighten specific stories. When a rehearsed answer lands well, offer to bank it with save_prep_answer so it compounds for future applications.

Style: short, plain, and warm; interviews are nerve-wracking and you are the calm corner. Encouraging without flattery, direct without bluntness. No em dashes, no filler. One question at a time. If they have limited time before the interview, lead with what moves the needle most.`;

const TOOLS: Anthropic.Messages.ToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
  {
    name: "save_prep_answer",
    description:
      "Bank a rehearsed, candidate-approved interview answer for reuse across applications. Call only after the candidate approved the wording.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The interview question, canonical form" },
        answer: { type: "string", description: "The approved answer" },
        topics: { type: "array", items: { type: "string" }, description: "Reuse tags, e.g. ['behavioral','conflict']" },
      },
      required: ["question", "answer"],
    },
  },
];

export async function runInterviewPrepTurn(
  apiKey: string,
  store: DriveStore,
  appId: string,
  transcript: ChatMessage[],
  modelId?: string,
  emit?: Partial<TurnEmit>,
): Promise<PrepTurnResult> {
  const meta = await readMeta(store, appId);
  if (!meta) throw new ClaudeUserError("Application not found.");
  const [report, snapshot, experiences, qaIndex] = await Promise.all([
    readScoreReport<ScoreReport>(store, appId),
    readSnapshot(store, appId),
    loadExperiences(store),
    loadQAIndex(store).catch(() => ({ entries: [] })),
  ]);

  const recentQA = [...qaIndex.entries]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 10);
  const banked = (
    await Promise.all(recentQA.map((e) => readQA(store, e.slug).catch(() => null)))
  ).filter((e): e is NonNullable<typeof e> => e !== null);

  const context = [
    `INTERVIEW PREP for: ${meta.role} at ${meta.company}${meta.source_url ? ` (${meta.source_url})` : ""}`,
    `Application status: ${meta.status}.`,
    "",
    "JOB AD (snapshot):",
    "```",
    (snapshot ?? "").slice(0, 10_000),
    "```",
    "",
    report ? `HONEST FIT SCORE:\n\`\`\`json\n${JSON.stringify(report, null, 2).slice(0, 8_000)}\n\`\`\`` : "No score report on file.",
    "",
    "CANDIDATE KNOWLEDGE BASE (real facts only; this is the entire evidence pool):",
    "```md",
    experiences.map(serializeExperience).join("\n\n---\n\n").slice(0, 55_000),
    "```",
    "",
    banked.length
      ? `BANKED ANSWERS from past applications:\n${banked.map((q) => `Q: ${q.canonical_question}\nA: ${q.answer}`).join("\n\n").slice(0, 8_000)}`
      : "BANKED ANSWERS: none yet.",
    "",
    "(You are now live with the candidate. First turn: one-line greeting, then ask for the interview invite details or 'skip'.)",
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: context },
    ...transcript.map((m) => ({ role: m.role, content: m.content })),
  ];

  const model = resolveModel(modelId);
  const client = new Anthropic({ apiKey });
  const replyParts: string[] = [];
  const answersSaved: string[] = [];

  try {
    for (let i = 0; i < 8; i++) {
      const stream = client.messages.stream({
        model: model.id,
        max_tokens: 16000,
        ...(model.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
        system: SYSTEM,
        tools: TOOLS,
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

      // Server-side web search pauses the turn; resume by echoing the content.
      if (response.stop_reason === "pause_turn") {
        emit?.status?.("Researching the company…");
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name === "save_prep_answer") {
          const input = tu.input as { question: string; answer: string; topics?: string[] };
          await upsertQA(store, {
            canonical_question: input.question,
            answer: input.answer,
            topics: input.topics,
            source_app: appId,
            at: new Date().toISOString(),
          });
          answersSaved.push(input.question);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "Answer banked for reuse." });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: `Unknown tool ${tu.name}.`,
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    toUserError(err);
  }

  const reply = replyParts.join("\n\n");
  const fullTranscript: ChatMessage[] = [...transcript, { role: "assistant" as const, content: reply }].slice(-60);
  await store.writeJson(["applications", appId, "interview-prep.json"], { messages: fullTranscript });

  return { reply, answersSaved };
}
