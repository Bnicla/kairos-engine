/**
 * Cost report: summarize traced model spans (traces/<YYYY-MM>.json).
 *
 *   npm run eval:costs                      (reads ~/Kairos, or KAIROS_HOME)
 *
 * Honest scope: only the cloud lane's SDK calls are traced (usage is reported
 * there). The local lane reasons through the Claude Code CLI (flat-rate Max),
 * which exposes no per-call usage — untraced by design, never estimated.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { summarizeSpans, type ModelSpan } from "../apps/cloud/lib/tracing";

const TRACES = join(process.env.KAIROS_HOME ?? join(homedir(), "Kairos"), "traces");
if (!existsSync(TRACES)) {
  console.log(`No traces at ${TRACES} yet — spans are written by the cloud lane's SDK calls (the local CLI lane is flat-rate and untraced by design).`);
  process.exit(0);
}
const spans: ModelSpan[] = readdirSync(TRACES)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(TRACES, f), "utf8")) as ModelSpan[]);
const s = summarizeSpans(spans);
console.log(`Model spend · ${s.calls} calls · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out tokens · $${s.costUsd.toFixed(2)}`);
for (const [task, t] of Object.entries(s.byTask).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
  console.log(`  ${task.padEnd(14)} ${String(t.calls).padStart(4)} calls  $${t.costUsd.toFixed(2)}`);
}
const perApp = new Map<string, number>();
for (const sp of spans) if (sp.appId) perApp.set(sp.appId, (perApp.get(sp.appId) ?? 0) + (sp.costUsd ?? 0));
if (perApp.size) {
  const costs = [...perApp.values()].sort((a, b) => a - b);
  console.log(`Per-application (n=${costs.length}): median $${costs[Math.floor(costs.length / 2)].toFixed(2)} · max $${costs.at(-1)!.toFixed(2)}`);
}
