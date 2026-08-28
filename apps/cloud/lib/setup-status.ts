import type { DriveStore } from "../store/drive";
import { getAnthropicKeyMasked } from "./session";

/**
 * The student's setup progress, read from THEIR Drive. Drives the home
 * checklist and the settings status chips.
 */
export interface SetupStatus {
  driveReady: boolean;
  keyMasked: string | null;
  template: { source: string; detected: string[] } | null;
  /** Extracted roles in the knowledge base (0 = onboarding not run yet). */
  kbRoles: number;
  /** Ready for onboarding: Drive tree exists and a key is on file. */
  ready: boolean;
}

export async function getSetupStatus(store: DriveStore): Promise<SetupStatus> {
  let driveReady = false;
  let keyMasked: string | null = null;
  let template: SetupStatus["template"] = null;
  let kbRoles = 0;
  try {
    driveReady = (await store.listFolders([])).some((f) => f.name === "knowledge-base");
    if (driveReady) {
      [keyMasked, template, kbRoles] = await Promise.all([
        getAnthropicKeyMasked(store),
        store.readJson<{ source: string; detected: string[] }>(["templates", "template-spec.json"]),
        store
          .listFiles(["knowledge-base", "experiences"])
          .then((files) => files.filter((f) => f.name.endsWith(".md")).length),
      ]);
    }
  } catch {
    // Root folder absent — brand-new user; everything stays false/null.
  }
  return { driveReady, keyMasked, template, kbRoles, ready: driveReady && keyMasked !== null };
}
