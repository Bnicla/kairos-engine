import type { Store } from "@kairos/engine/store/types";
import { slugify } from "@kairos/engine/applications";

/**
 * Q&A bank — reusable answers to application questions ("Why this company?",
 * "Describe a time you led through conflict"). Canonical-question indexing lets
 * Kairos surface a prior answer when a similar question appears on a new ad, so
 * answers sharpen over time instead of being rewritten from scratch.
 */

export interface QAEntry {
  slug: string;
  canonical_question: string;
  answer: string;
  topics: string[];
  source_app?: string;
  updated_at: string;
}

interface QAIndex {
  entries: { slug: string; canonical_question: string; topics: string[]; updated_at: string }[];
}

const DIR = "qa-bank";
const INDEX = [DIR, "_index.json"];

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "your", "you", "why", "what", "how", "do", "does", "is", "are", "with", "at", "this", "that", "describe", "tell", "us", "me", "about"]);
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}

export async function loadQAIndex(store: Store): Promise<QAIndex> {
  return (await store.readJson<QAIndex>(INDEX)) ?? { entries: [] };
}

export async function readQA(store: Store, slug: string): Promise<QAEntry | null> {
  const raw = await store.readFile([DIR, `q-${slug}.md`]);
  if (!raw) return null;
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return {
    slug,
    canonical_question: fm.canonical_question ?? "",
    answer: m[2].trim(),
    topics: fm.topics ? fm.topics.split(",").map((t) => t.trim()).filter(Boolean) : [],
    source_app: fm.source_app,
    updated_at: fm.updated_at ?? "",
  };
}

export async function upsertQA(
  store: Store,
  input: { canonical_question: string; answer: string; topics?: string[]; source_app?: string; at: string },
): Promise<QAEntry> {
  const slug = slugify(input.canonical_question);
  const topics = input.topics ?? [];
  const body = [
    "---",
    `canonical_question: ${JSON.stringify(input.canonical_question)}`,
    `topics: ${topics.join(", ")}`,
    input.source_app ? `source_app: ${input.source_app}` : null,
    `updated_at: ${input.at}`,
    "---",
    "",
    input.answer.trim(),
    "",
  ].filter((l) => l !== null).join("\n");
  await store.writeFile([DIR, `q-${slug}.md`], body);

  const idx = await loadQAIndex(store);
  const entry = { slug, canonical_question: input.canonical_question, topics, updated_at: input.at };
  const i = idx.entries.findIndex((e) => e.slug === slug);
  if (i === -1) idx.entries.push(entry);
  else idx.entries[i] = entry;
  await store.writeJson(INDEX, idx);

  return { ...entry, answer: input.answer.trim(), source_app: input.source_app };
}

/** Rank stored answers by token/topic overlap with a new question. */
export async function searchQA(
  store: Store,
  question: string,
  limit = 3,
): Promise<{ slug: string; canonical_question: string; answer: string; topics: string[]; score: number }[]> {
  const idx = await loadQAIndex(store);
  const q = new Set(tokens(question));
  if (q.size === 0) return [];
  const scored = idx.entries
    .map((e) => {
      const cand = new Set([...tokens(e.canonical_question), ...e.topics.flatMap(tokens)]);
      let overlap = 0;
      for (const t of q) if (cand.has(t)) overlap++;
      return { entry: e, score: overlap / q.size };
    })
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const out = [];
  for (const s of scored) {
    const full = await readQA(store, s.entry.slug);
    if (full) out.push({ slug: full.slug, canonical_question: full.canonical_question, answer: full.answer, topics: full.topics, score: Number(s.score.toFixed(2)) });
  }
  return out;
}
