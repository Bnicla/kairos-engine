import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * App-layer envelope encryption for the one secret we must persist: the user's
 * Anthropic API key. The ciphertext lives in the USER'S Drive (DEC-5 — we run no
 * user datastore); AES-256-GCM with a server-only key means neither Drive nor
 * anyone reading it can recover the plaintext without the encryption key
 * (server env only, never in Drive, never in the browser).
 *
 * KEY ROTATION (REQ-5): `KAIROS_ENCRYPTION_KEYS` holds a comma-separated list
 * of base64 32-byte keys. The FIRST entry encrypts everything new; every entry
 * is tried for decryption, matched by key id (first 8 hex chars of the key's
 * SHA-256). Rotation = prepend a fresh key and keep the old one until lazy
 * re-encryption (see session.ts) has swept it out of use. The legacy singular
 * `KAIROS_ENCRYPTION_KEY` still works and is treated as the last list entry.
 *
 * Stored formats:
 *   v1.<keyId>.<iv>.<tag>.<ct>   current (all base64 except keyId)
 *   <iv>.<tag>.<ct>              legacy — decrypts by trying every key
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length

interface KeyEntry {
  id: string;
  key: Buffer;
}

function keyId(key: Buffer): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function parseKey(raw: string, source: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `${source} must decode to 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

function getKeys(): KeyEntry[] {
  const list = (process.env.KAIROS_ENCRYPTION_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw, i) => parseKey(raw, `KAIROS_ENCRYPTION_KEYS[${i}]`));
  const legacy = process.env.KAIROS_ENCRYPTION_KEY;
  if (legacy) list.push(parseKey(legacy, "KAIROS_ENCRYPTION_KEY"));
  if (list.length === 0) {
    throw new Error(
      "No encryption key configured. Set KAIROS_ENCRYPTION_KEYS (comma-separated, first entry is primary) or KAIROS_ENCRYPTION_KEY. Generate one with: openssl rand -base64 32",
    );
  }
  return list.map((key) => ({ id: keyId(key), key }));
}

export function encryptSecret(plaintext: string): string {
  const primary = getKeys()[0];
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, primary.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    "v1",
    primary.id,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function gcmDecrypt(key: Buffer, ivB64: string, tagB64: string, dataB64: string): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export interface DecryptedSecret {
  plaintext: string;
  /** true when NOT encrypted under the current primary key — re-encrypt and write back. */
  needsReencrypt: boolean;
}

export function decryptSecretDetailed(payload: string): DecryptedSecret {
  const keys = getKeys();
  const parts = payload.split(".");

  if (parts[0] === "v1" && parts.length === 5) {
    const [, id, ivB64, tagB64, dataB64] = parts;
    const match = keys.find((k) => k.id === id);
    if (!match) {
      throw new Error(
        `Encrypted secret uses key id "${id}" which is not in KAIROS_ENCRYPTION_KEYS — the key it was encrypted with has been removed.`,
      );
    }
    return {
      plaintext: gcmDecrypt(match.key, ivB64, tagB64, dataB64),
      needsReencrypt: match.id !== keys[0].id,
    };
  }

  // Legacy 3-part payload: unknown key id, so try every configured key.
  if (parts.length === 3) {
    const [ivB64, tagB64, dataB64] = parts;
    let lastError: unknown = null;
    for (const k of keys) {
      try {
        return { plaintext: gcmDecrypt(k.key, ivB64, tagB64, dataB64), needsReencrypt: true };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Malformed encrypted secret");
  }

  throw new Error("Malformed encrypted secret");
}

/** Back-compat simple form. Prefer decryptSecretDetailed for lazy rotation. */
export function decryptSecret(payload: string): string {
  return decryptSecretDetailed(payload).plaintext;
}

/** Mask a key for display, e.g. "sk-ant…a1b2". Never returns the full key. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 6)}…${plaintext.slice(-4)}`;
}
