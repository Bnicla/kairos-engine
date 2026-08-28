import type { FileEntry, FolderEntry, Store } from "@kairos/engine/store/types";
import { FOLDER_MIME, googleDriveOps, type DriveOps } from "./drive-ops";
import { CONTENT_TTL_MS, type DriveCache } from "./user-cache";

/**
 * Google Drive Store adapter — the cloud lane's persistence, over the SAME
 * Store interface the engine consumes (DEC-3). All content lives in the USER's
 * Drive under one `Kairos/` root, `drive.file`-scoped: the app sees only files
 * it created; deleting the folder deletes the data (N4-cloud / DEC-5).
 *
 * Semantics mirror LocalStore exactly:
 *   - reads of missing files/folders  → null / []
 *   - corrupt JSON                    → throw (never masquerade as "missing")
 *   - writes                          → parents auto-created, overwrite in place
 *
 * Drive addresses by id, not path, and every hop costs a network call — so
 * resolved folder/file ids are cached. Safe because an overwrite is
 * `files.update` (id stable) and this app is the only writer in its scope.
 * Pass a shared per-user DriveCache (store/user-cache.ts) so the resolution
 * work survives across requests; without one the instance falls back to
 * private per-request maps.
 */
export class DriveStore implements Store {
  private readonly ops: DriveOps;
  private readonly rootName: string;
  private readonly folderIds: Map<string, string>;
  private readonly fileIds: Map<string, string>;
  private readonly content: DriveCache["content"];
  private readonly lists: DriveCache["lists"];

  constructor(ops: DriveOps, opts: { rootName?: string; cache?: DriveCache } = {}) {
    this.ops = ops;
    this.rootName = opts.rootName ?? "Kairos";
    this.folderIds = opts.cache?.folderIds ?? new Map();
    this.fileIds = opts.cache?.fileIds ?? new Map();
    this.content = opts.cache?.content ?? new Map();
    this.lists = opts.cache?.lists ?? new Map();
  }

  static fromAccessToken(
    accessToken: string,
    opts: { rootName?: string; cache?: DriveCache } = {},
  ): DriveStore {
    return new DriveStore(googleDriveOps(accessToken), opts);
  }

  /** Create (or confirm) the root + standard tree. Call once at first connect. */
  async initTree(): Promise<void> {
    const root = await this.resolveFolder([], true);
    for (const [child, grandchildren] of Object.entries({
      "knowledge-base": ["experiences", "education"],
      applications: [],
      "qa-bank": [],
    })) {
      const childId = await this.ensureChildFolder(child, root, [child]);
      for (const gc of grandchildren) await this.ensureChildFolder(gc, childId, [child, gc]);
    }
  }

  async listFiles(folderPath: string[]): Promise<FileEntry[]> {
    const cacheKey = `files:${this.key(folderPath)}`;
    const hit = this.lists.get(cacheKey);
    if (hit && Date.now() - hit.at < CONTENT_TTL_MS) return hit.value as FileEntry[];
    const parent = await this.resolveFolder(folderPath, false).catch(() => null);
    if (!parent) return [];
    const value = (await this.ops.listChildren(parent, "files")).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
    }));
    this.lists.set(cacheKey, { value, at: Date.now() });
    return value;
  }

  async listFolders(folderPath: string[]): Promise<FolderEntry[]> {
    const cacheKey = `folders:${this.key(folderPath)}`;
    const hit = this.lists.get(cacheKey);
    if (hit && Date.now() - hit.at < CONTENT_TTL_MS) return hit.value as FolderEntry[];
    const parent = await this.resolveFolder(folderPath, false).catch(() => null);
    if (!parent) return [];
    const value = (await this.ops.listChildren(parent, "folders")).map((f) => ({ id: f.id, name: f.name }));
    this.lists.set(cacheKey, { value, at: Date.now() });
    return value;
  }

  async readFile(filePath: string[]): Promise<string | null> {
    const k = this.key(filePath);
    // The applications index is read-modify-written across serverless
    // instances; serving it from cache widens the clobber window. Always fresh.
    if (k === "_index.json") return this.readFileFresh(filePath);
    const hit = this.content.get(k);
    if (hit && Date.now() - hit.at < CONTENT_TTL_MS) return hit.value;
    const value = await this.readFileFresh(filePath);
    this.content.set(k, { value, at: Date.now() });
    return value;
  }

  /** Uncached read with one self-heal retry against a stale cached file id. */
  private async readFileFresh(filePath: string[]): Promise<string | null> {
    const k = this.key(filePath);
    const id = await this.resolveFileId(filePath);
    if (!id) return null;
    try {
      return await this.ops.downloadText(id);
    } catch {
      // Id may be stale (file deleted/moved outside the app). Re-resolve once.
      this.fileIds.delete(k);
      const freshId = await this.resolveFileId(filePath);
      if (!freshId || freshId === id) return null;
      return this.ops.downloadText(freshId);
    }
  }

  async readBinary(filePath: string[]): Promise<Buffer | null> {
    const id = await this.resolveFileId(filePath);
    return id ? this.ops.downloadBinary(id) : null;
  }

  async writeFile(filePath: string[], content: string, mimeType = "text/markdown"): Promise<string> {
    return this.write(filePath, content, mimeType);
  }

  async writeBinary(filePath: string[], buffer: Buffer, mimeType = "application/octet-stream"): Promise<string> {
    return this.write(filePath, buffer, mimeType);
  }

  async readJson<T>(filePath: string[]): Promise<T | null> {
    const raw = await this.readFile(filePath);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      // Same contract as LocalStore: corruption surfaces; only absence is null.
      throw new Error(`Corrupt JSON at ${filePath.join("/")}: ${(e as Error).message}`);
    }
  }

  async writeJson(filePath: string[], data: unknown): Promise<string> {
    return this.writeFile(filePath, JSON.stringify(data, null, 2), "application/json");
  }

  /**
   * Create a folder path if missing (parents included). Callers that write
   * many files in parallel pre-create folders through this so concurrent
   * writes never race to create the same folder (Drive would duplicate it).
   */
  async ensureFolder(folderPath: string[]): Promise<void> {
    await this.resolveFolder(folderPath, true);
  }

  /**
   * Delete a whole folder subtree (Drive deletes children with the folder).
   * Returns false when the folder doesn't exist. Purges every cached id,
   * content entry, and listing under the path so nothing resolves stale.
   */
  async deleteFolder(folderPath: string[]): Promise<boolean> {
    const id = await this.resolveFolder(folderPath, false).catch(() => null);
    if (!id) return false;
    await this.ops.deleteFile(id);
    const prefix = this.key(folderPath);
    for (const map of [this.folderIds, this.fileIds, this.content]) {
      for (const k of [...map.keys()]) {
        if (k === prefix || k.startsWith(prefix + "/")) map.delete(k);
      }
    }
    // Listings are cheap to rebuild; drop them all rather than prefix-match
    // both the subtree and the parent's own listing.
    this.lists.clear();
    return true;
  }

  // -- internals -------------------------------------------------------------

  private key(segments: string[]): string {
    return segments.join("/");
  }

  private async ensureChildFolder(name: string, parentId: string, pathSegs: string[]): Promise<string> {
    const cached = this.folderIds.get(this.key(pathSegs));
    if (cached) return cached;
    const id = (await this.ops.findFolder(name, parentId)) ?? (await this.ops.createFolder(name, parentId));
    this.folderIds.set(this.key(pathSegs), id);
    return id;
  }

  /**
   * Resolve a folder path (["applications","<appId>"]) to a Drive folder id.
   * The empty path is the Kairos root. Throws when missing and !create.
   */
  private async resolveFolder(segments: string[], create: boolean): Promise<string> {
    // Walk down from the deepest cached prefix.
    let i = segments.length;
    let parent: string | undefined;
    for (; i > 0; i--) {
      const hit = this.folderIds.get(this.key(segments.slice(0, i)));
      if (hit) {
        parent = hit;
        break;
      }
    }
    if (parent === undefined) {
      const cachedRoot = this.folderIds.get("");
      if (cachedRoot) {
        parent = cachedRoot;
      } else {
        const found = await this.ops.findFolder(this.rootName);
        if (found) parent = found;
        else if (create) parent = await this.ops.createFolder(this.rootName);
        else throw new Error(`Drive folder not found: ${this.rootName}`);
        this.folderIds.set("", parent);
      }
      i = 0;
    }
    for (; i < segments.length; i++) {
      const seg = segments[i];
      const pathKey = this.key(segments.slice(0, i + 1));
      const found = await this.ops.findFolder(seg, parent);
      if (found) {
        parent = found;
      } else if (create) {
        parent = await this.ops.createFolder(seg, parent);
      } else {
        throw new Error(`Drive folder not found: ${this.rootName}/${this.key(segments)}`);
      }
      this.folderIds.set(pathKey, parent);
    }
    return parent;
  }

  private async resolveFileId(filePath: string[]): Promise<string | null> {
    const cached = this.fileIds.get(this.key(filePath));
    if (cached) return cached;
    const name = filePath[filePath.length - 1];
    const folder = await this.resolveFolder(filePath.slice(0, -1), false).catch(() => null);
    if (!folder) return null;
    const file = await this.ops.findFile(name, folder);
    if (!file || file.mimeType === FOLDER_MIME) return null;
    this.fileIds.set(this.key(filePath), file.id);
    return file.id;
  }

  private async write(filePath: string[], body: string | Buffer, mimeType: string): Promise<string> {
    const name = filePath[filePath.length - 1];
    const folder = await this.resolveFolder(filePath.slice(0, -1), true);
    const existingId = this.fileIds.get(this.key(filePath)) ?? (await this.ops.findFile(name, folder))?.id;
    const id = existingId
      ? await this.ops.updateFile(existingId, body, mimeType)
      : await this.ops.createFile(name, folder, body, mimeType);
    this.fileIds.set(this.key(filePath), id);
    // Write-through: readers in the freshness window see what was just written.
    this.content.set(
      this.key(filePath),
      { value: typeof body === "string" ? body : null, at: typeof body === "string" ? Date.now() : 0 },
    );
    this.lists.delete(`files:${this.key(filePath.slice(0, -1))}`);
    return id;
  }
}
