import type { RegistryEntry } from "./types";

/**
 * Registry loading (REQ-15): the harvested board list is DATA, not source.
 * Callers load it from their data path (local: ~/Kairos/sourcing/registry.json;
 * cloud: the user's Drive) and fall back to the committed seed only when no
 * harvested copy exists. Harvested data goes stale silently — staleness is
 * surfaced, never assumed away.
 */

export interface RegistryFile {
  version?: number;
  harvested_at?: string;
  entries: RegistryEntry[];
}

/** Parse + minimally validate a registry payload; null when unusable. */
export function parseRegistry(data: unknown): RegistryFile | null {
  const d = data as RegistryFile | null;
  if (!d || !Array.isArray(d.entries) || d.entries.length === 0) return null;
  const entries = d.entries.filter(
    (e): e is RegistryEntry => !!e && typeof e.slug === "string" && typeof e.ats === "string",
  );
  return entries.length ? { version: d.version, harvested_at: d.harvested_at, entries } : null;
}

export const REGISTRY_STALE_DAYS = 30;

/** Human-readable staleness warning, or null when fresh/undated-unknowable. */
export function registryStalenessWarning(harvestedAt: string | undefined, now = Date.now()): string | null {
  if (!harvestedAt) return "registry has no harvested_at date — freshness unknown; consider re-harvesting";
  const ageDays = Math.floor((now - new Date(harvestedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(ageDays)) return null;
  return ageDays > REGISTRY_STALE_DAYS
    ? `registry is ${ageDays} days old (harvested ${harvestedAt.slice(0, 10)}) — boards decay; re-run the harvest`
    : null;
}

/**
 * Resolve the registry: prefer the caller-supplied data copy, fall back to the
 * seed. Returns the chosen file plus which source won and any staleness note,
 * so callers can log honestly.
 */
export function resolveRegistry(
  dataCopy: unknown,
  seed: RegistryFile,
  now = Date.now(),
): { registry: RegistryFile; source: "data" | "seed"; staleness: string | null } {
  const parsed = parseRegistry(dataCopy);
  const registry = parsed ?? seed;
  return {
    registry,
    source: parsed ? "data" : "seed",
    staleness: registryStalenessWarning(registry.harvested_at, now),
  };
}
