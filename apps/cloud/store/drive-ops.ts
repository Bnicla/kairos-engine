import { google, type drive_v3 } from "googleapis";
import { Readable } from "node:stream";

/**
 * Minimal Drive operations the DriveStore is built on. The real implementation
 * (googleDriveOps) wraps googleapis under the `drive.file` scope — the app can
 * only ever see files it created, so name+parent lookups are collision-safe.
 * Tests implement this interface over an in-memory tree instead (no query
 * strings to fake), keeping all DriveStore path/cache/semantics logic testable.
 */
export interface DriveOps {
  findFolder(name: string, parentId?: string): Promise<string | null>;
  createFolder(name: string, parentId?: string): Promise<string>;
  findFile(name: string, parentId: string): Promise<{ id: string; mimeType: string } | null>;
  listChildren(parentId: string, kind: "files" | "folders"): Promise<{ id: string; name: string; mimeType: string }[]>;
  downloadText(fileId: string): Promise<string>;
  downloadBinary(fileId: string): Promise<Buffer>;
  createFile(name: string, parentId: string, body: string | Buffer, mimeType: string): Promise<string>;
  updateFile(fileId: string, body: string | Buffer, mimeType: string): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Escape a value for a Drive query `name = '...'` clause. */
export const escapeQueryValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * Retry/backoff for Drive calls (REQ-7). Drive 429/5xx are routine under load,
 * and quota is shared per Google Cloud project across ALL users — one heavy
 * user degrades everyone, so absorbing transient throttles here matters.
 * Retries up to 2 extra attempts on 429/500/502/503 with exponential backoff +
 * jitter, honoring Retry-After when Drive names a wait (capped at 10s).
 */
const RETRYABLE = new Set([429, 500, 502, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function driveStatus(err: unknown): number | undefined {
  const e = err as { code?: number | string; response?: { status?: number } } | null;
  const raw = e?.response?.status ?? e?.code;
  const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
  return Number.isFinite(n) ? (n as number) : undefined;
}

function retryAfterMs(err: unknown): number | null {
  const h = (err as { response?: { headers?: Record<string, string> } })?.response?.headers?.["retry-after"];
  const s = Number(h);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 10_000) : null;
}

export async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = driveStatus(err);
      if (i >= attempts - 1 || status === undefined || !RETRYABLE.has(status)) throw err;
      const wait = retryAfterMs(err) ?? Math.min(400 * 2 ** i + Math.random() * 300, 10_000);
      await sleep(wait);
    }
  }
}

/** Wrap every op in withBackoff — exported separately so tests can exercise it over fake ops. */
export function withDriveBackoff(ops: DriveOps): DriveOps {
  const wrapped = {} as DriveOps;
  for (const key of Object.keys(ops) as (keyof DriveOps)[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapped as any)[key] = (...args: unknown[]) => withBackoff(() => (ops[key] as any)(...args));
  }
  return wrapped;
}

export function googleDriveOps(accessToken: string): DriveOps {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive: drive_v3.Drive = google.drive({ version: "v3", auth });

  return withDriveBackoff(buildRawOps(drive));
}

function buildRawOps(drive: drive_v3.Drive): DriveOps {
  const media = (body: string | Buffer, mimeType: string) => ({
    mimeType,
    body: typeof body === "string" ? body : Readable.from(body),
  });

  return {
    async findFolder(name, parentId) {
      const res = await drive.files.list({
        q: [
          `name = '${escapeQueryValue(name)}'`,
          `mimeType = '${FOLDER_MIME}'`,
          "trashed = false",
          parentId ? `'${parentId}' in parents` : "'root' in parents",
        ].join(" and "),
        fields: "files(id)",
        spaces: "drive",
        pageSize: 1,
      });
      return res.data.files?.[0]?.id ?? null;
    },

    async createFolder(name, parentId) {
      const res = await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
        fields: "id",
      });
      if (!res.data.id) throw new Error(`Drive returned no id for folder "${name}"`);
      return res.data.id;
    },

    async findFile(name, parentId) {
      const res = await drive.files.list({
        q: [`name = '${escapeQueryValue(name)}'`, `'${parentId}' in parents`, "trashed = false"].join(" and "),
        fields: "files(id, mimeType)",
        spaces: "drive",
        pageSize: 1,
      });
      const f = res.data.files?.[0];
      return f?.id ? { id: f.id, mimeType: f.mimeType ?? "" } : null;
    },

    async listChildren(parentId, kind) {
      const res = await drive.files.list({
        q: [
          `'${parentId}' in parents`,
          `mimeType ${kind === "folders" ? "=" : "!="} '${FOLDER_MIME}'`,
          "trashed = false",
        ].join(" and "),
        fields: "files(id, name, mimeType)",
        spaces: "drive",
        pageSize: 500,
        orderBy: "name",
      });
      return (res.data.files ?? []).map((f) => ({ id: f.id!, name: f.name!, mimeType: f.mimeType ?? "" }));
    },

    async downloadText(fileId) {
      const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
      return typeof res.data === "string" ? res.data : String(res.data);
    },

    async downloadBinary(fileId) {
      const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      return Buffer.from(res.data as ArrayBuffer);
    },

    async createFile(name, parentId, body, mimeType) {
      const res = await drive.files.create({
        requestBody: { name, parents: [parentId], mimeType },
        media: media(body, mimeType),
        fields: "id",
      });
      if (!res.data.id) throw new Error(`Drive returned no id for file "${name}"`);
      return res.data.id;
    },

    async updateFile(fileId, body, mimeType) {
      const res = await drive.files.update({ fileId, media: media(body, mimeType), fields: "id" });
      return res.data.id ?? fileId;
    },

    async deleteFile(fileId) {
      await drive.files.delete({ fileId });
    },
  };
}
