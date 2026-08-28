import { auth } from "../auth";
import { DriveStore } from "../store/drive";
import { driveCacheFor } from "../store/user-cache";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";

/**
 * Per-request context (DEC-5: everything in memory, nothing persisted our side).
 * Every server action / route resolves this first: identity from the JWT cookie,
 * a DriveStore bound to this user's token, and (when needed) the Anthropic key
 * decrypted from the USER'S Drive.
 */

export interface SessionContext {
  email: string;
  accessToken: string;
  store: DriveStore;
}

export async function getSessionContext(): Promise<SessionContext | { error: string }> {
  const session = await auth();
  if (!session?.user?.email) return { error: "not_signed_in" };
  if (session.error) return { error: session.error };
  if (!session.access_token) return { error: "no_drive_token" };
  // Granular consent: the user can sign in yet deny the Drive checkbox. Catch
  // it here so the UI explains, instead of every Drive call 403-crashing.
  if (session.scope && !session.scope.includes("drive.file")) {
    return { error: "drive_not_granted" };
  }
  return {
    email: session.user.email,
    accessToken: session.access_token,
    // Shared per-user cache: folder/file ids survive across requests, so a
    // navigation costs a couple of Drive calls instead of re-walking the tree.
    store: DriveStore.fromAccessToken(session.access_token, {
      cache: driveCacheFor(session.user.email),
    }),
  };
}

export const isContextError = (c: SessionContext | { error: string }): c is { error: string } =>
  "error" in c;

const KEY_PATH = [".secrets", "anthropic.json"];

interface StoredKey {
  enc: string;
  masked: string;
}

/** Encrypt the user's Anthropic key into THEIR Drive. We keep nothing. */
export async function setAnthropicKey(store: DriveStore, plaintext: string): Promise<string> {
  const record: StoredKey = { enc: encryptSecret(plaintext), masked: maskSecret(plaintext) };
  await store.writeJson(KEY_PATH, record);
  return record.masked;
}

/** The masked display form, or null if no key is stored yet. */
export async function getAnthropicKeyMasked(store: DriveStore): Promise<string | null> {
  const record = await store.readJson<StoredKey>(KEY_PATH);
  return record?.masked ?? null;
}

/** Decrypt the key for an API call. Never log, never return to the client. */
export async function getAnthropicKey(store: DriveStore): Promise<string | null> {
  const record = await store.readJson<StoredKey>(KEY_PATH);
  return record ? decryptSecret(record.enc) : null;
}
