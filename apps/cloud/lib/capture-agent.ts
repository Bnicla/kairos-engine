import Anthropic from "@anthropic-ai/sdk";
import type { DriveStore } from "../store/drive";
import { createApplication } from "@kairos/engine/applications";
import { ClaudeUserError, toUserError } from "./claude";
import { runScoringForApp } from "./apps-agent";
import type { ChatMessage } from "./enrich-agent";
import type { TurnEmit } from "./sse";

/**
 * Conversational application capture. The student gives a URL; the agent tries
 * to fetch the ad server-side. When a job board blocks us we say so plainly and
 * ask for a paste (no workarounds — the honest path). Capture then triggers the
 * Opus scoring pass inside the same turn.
 */

export interface CaptureTurnResult {
  reply: string;
  appId: string | null;
}

const SYSTEM = `You help a candidate start a job application inside Kairos, an authenticity-preserving career tool. Your ONLY job in this chat: obtain the job ad (from a link, an uploaded file, or pasted text), then capture and score it.

The candidate may give you any of three sources, in any order:
- A URL: call fetch_job_ad on it immediately.
- An uploaded file: arrives as a message starting "UPLOADED AD FILE" with the extracted text.
- Pasted text: the ad copied straight into the chat.

Verify before capturing, whatever the source: does the content actually read like ONE job ad (a role, a company, responsibilities or requirements)? If yes, extract the company name and role title and call capture_application right away, with no confirmation round-trip. Then report the result in one or two lines.

Recovery, when a source is bad, and this is as important as the happy path:
- Fetch failed or blocked (login wall, cookie page, empty shell): say plainly what happened in one sentence. Never guess at ad content, never try alternative URLs or workarounds.
- Uploaded file that is not a job ad (a resume, an offer letter, the wrong document): say what the file appears to be, so they realize which file they grabbed.
- Pasted text that looks wrong (a cover letter, half an ad, a different page): say what it looks like and what is missing.
In every bad-source case, close by offering the alternatives: try another link, upload the ad as a file, or paste the text directly. Stay in the conversation until one source works or they stop.

capture_application snapshots the ad and scores the candidate against their knowledge base; it takes about a minute. When it returns, relay the band and recommendation in plain language, one or two sentences. Do not flatter, do not soften a weak result. Then tell them the scorecard page is next, where Kairos keeps the conversation going to close gaps before drafting.

Tone: you're helping someone through a stressful process, so sound like a helpful person, never a form validator. Acknowledge what they gave you before asking for anything else. When something fails, reassure first ("no problem, this happens with LinkedIn"), then offer the way forward. Short does not mean curt: one warm, plain sentence beats a command. Encouraging without flattery. No em dashes.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "fetch_job_ad",
    description: "Fetch a job ad URL server-side and return its readable text. Fails on blocked or unreadable pages.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The job ad URL" } },
      required: ["url"],
    },
  },
  {
    name: "capture_application",
    description:
      "Snapshot the job ad and score the candidate against it. Call once you have the ad text and have extracted company + role from it.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string" },
        role: { type: "string", description: "The role title as the ad states it" },
        job_text: { type: "string", description: "The full ad text (fetched or pasted), verbatim" },
        source_url: { type: "string", description: "The ad URL, if one was given" },
      },
      required: ["company", "role", "job_text"],
    },
  },
];

async function fetchJobAd(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) URLs are supported.");

  const res = await fetch(parsed.href, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The site answered ${res.status}.`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (text.length < 300) throw new Error("The page came back nearly empty (likely rendered by JavaScript or behind a login).");
  return text.slice(0, 60_000);
}

export async function runCaptureTurn(
  apiKey: string,
  store: DriveStore,
  transcript: ChatMessage[],
  emit?: Partial<TurnEmit>,
): Promise<CaptureTurnResult> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = transcript.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (messages.length === 0) throw new ClaudeUserError("Give me a job ad URL to start.");

  const replyParts: string[] = [];
  let appId: string | null = null;

  try {
    for (let i = 0; i < 5; i++) {
      const stream = client.messages.stream({
        model: "claude-sonnet-5",
        max_tokens: 8000,
        thinking: { type: "adaptive" },
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
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        if (tu.name === "fetch_job_ad") {
          const { url } = tu.input as { url: string };
          emit?.status?.("Reading the page…");
          try {
            const text = await fetchJobAd(url);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: `FETCHED AD TEXT:\n${text}` });
          } catch (err) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: `Could not read the page: ${err instanceof Error ? err.message : "unknown error"}`,
            });
          }
        } else if (tu.name === "capture_application") {
          const input = tu.input as { company: string; role: string; job_text: string; source_url?: string };
          if (!input.company?.trim() || !input.role?.trim() || (input.job_text ?? "").length < 200) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: "Missing company, role, or enough ad text (200+ chars).",
            });
            continue;
          }
          emit?.status?.("Snapshotting the ad & scoring you against it… about a minute");
          const meta = await createApplication(store, {
            company: input.company.trim(),
            role: input.role.trim(),
            snapshotMarkdown: input.job_text.slice(0, 60_000),
            source_url: input.source_url?.trim() || undefined,
          });
          appId = meta.id;
          try {
            const report = await runScoringForApp(apiKey, store, meta.id);
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Captured and scored. Band: ${report.match.overall_band} (${report.match.confidence} confidence). Recommendation: ${report.recommendation}.`,
            });
          } catch (err) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: `Captured, but scoring failed: ${err instanceof Error ? err.message : "unknown"}. The candidate can rescore from the application page.`,
            });
          }
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    toUserError(err);
  }

  return { reply: replyParts.join("\n\n"), appId };
}
