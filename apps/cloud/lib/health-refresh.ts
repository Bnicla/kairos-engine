import type { DriveStore } from "../store/drive";
import { loadExperiences } from "@kairos/engine/kb/store";
import { computeHealth, type HealthReport } from "@kairos/engine/health";

const KB = "knowledge-base";

/**
 * Recompute the deterministic health report from the KB in the student's Drive
 * and persist it. Contact + headline come back out of profile.md (written at
 * onboarding), so enrichment and future flows can refresh without re-asking.
 */
export async function refreshHealth(store: DriveStore): Promise<HealthReport> {
  const profile = (await store.readFile(["profile.md"])) ?? "";
  const lines = profile
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("Source:"));
  const contactLine = lines.find((l) => l.includes("@")) ?? lines[0] ?? "";
  const first = lines[0];
  const headline = first && first !== contactLine ? first : undefined;

  const experiences = await loadExperiences(store);
  const health = computeHealth(experiences, { contactLine, headline });
  await store.writeJson([KB, "_health.json"], {
    ...health,
    generated_at: new Date().toISOString(),
  });
  return health;
}
