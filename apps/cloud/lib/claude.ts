import Anthropic from "@anthropic-ai/sdk";
import { TASK_MODELS } from "./models";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  type ExtractionResult,
} from "@kairos/engine/prompts/extraction";

/**
 * Claude calls made with the STUDENT'S own key (DEC-1: BYO key, decrypted from
 * their Drive per request, never stored our side). One call = one onboarding
 * extraction; costs land on their Anthropic account.
 */

export class ClaudeUserError extends Error {}

export async function extractKnowledgeBase(
  apiKey: string,
  resumeText: string,
): Promise<ExtractionResult> {
  const client = new Anthropic({ apiKey });

  let message: Anthropic.Message;
  try {
    const stream = client.messages.stream({
      model: TASK_MODELS.extraction.id,
      max_tokens: TASK_MODELS.extraction.maxTokens,
      ...(TASK_MODELS.extraction.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildExtractionUserMessage(resumeText) }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ClaudeUserError(
        "Your Anthropic API key was rejected. Replace it in settings (it may have been revoked).",
      );
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ClaudeUserError("Anthropic rate limit hit on your key. Wait a minute and retry.");
    }
    if (err instanceof Anthropic.BadRequestError && /credit/i.test(err.message)) {
      throw new ClaudeUserError(
        "Your Anthropic account has no credits. Add credits at console.anthropic.com, then retry.",
      );
    }
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeUserError(`Claude call failed (${err.status ?? "network"}). Try again.`);
    }
    throw err;
  }

  if (message.stop_reason === "refusal") {
    throw new ClaudeUserError("Claude declined to process this document. Is it a résumé?");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ClaudeUserError("The résumé is too long to extract in one pass. Trim it and retry.");
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = parseJsonBlock<ExtractionResult>(text);
  if (!parsed || !Array.isArray(parsed.experiences)) {
    throw new ClaudeUserError("Extraction returned an unexpected shape. Try again.");
  }
  return parsed;
}

/** Map SDK errors to student-facing messages; rethrow anything unexpected. */
export function toUserError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) {
    throw new ClaudeUserError("Your Anthropic API key was rejected. Replace it in settings.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    throw new ClaudeUserError("Anthropic rate limit hit on your key. Wait a minute and retry.");
  }
  if (err instanceof Anthropic.BadRequestError && /credit/i.test(err.message)) {
    throw new ClaudeUserError(
      "Your Anthropic account has no credits. Add credits at console.anthropic.com, then retry.",
    );
  }
  if (err instanceof Anthropic.APIError) {
    throw new ClaudeUserError(`Claude call failed (${err.status ?? "network"}). Try again.`);
  }
  throw err;
}

/** Tolerate a ```json fence or stray prose around the JSON object. */
export function parseJsonBlock<T>(text: string): T | null {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1].trim());
  const braces = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (braces) candidates.push(braces);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* next candidate */
    }
  }
  return null;
}
