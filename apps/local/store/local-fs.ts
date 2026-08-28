import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, FolderEntry, Store } from "@kairos/engine/store/types";

/**
 * Local-filesystem Store adapter — the personal lane. All Kairos data lives under
 * ~/Kairos/ (override with KAIROS_HOME). Nothing leaves the machine.
 */

export function kairosHome(): string {
  const override = process.env.KAIROS_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), "Kairos");
}

/** Reject traversal / separators so a slug or appId can never escape the root. */
function safeSegment(seg: string): string {
  if (
    !seg ||
    seg === "." ||
    seg === ".." ||
    seg.includes("/") ||
    seg.includes("\\") ||
    seg.includes("\0")
  ) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};
function mimeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export class LocalStore implements Store {
  readonly root: string;

  constructor(root: string = kairosHome()) {
    this.root = root;
  }

  private abs(segments: string[]): string {
    return path.join(this.root, ...segments.map(safeSegment));
  }

  async listFiles(folderPath: string[]): Promise<FileEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(this.abs(folderPath), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => ({ id: e.name, name: e.name, mimeType: mimeFor(e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listFolders(folderPath: string[]): Promise<FolderEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(this.abs(folderPath), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ id: e.name, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(filePath: string[]): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(filePath), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async readBinary(filePath: string[]): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.abs(filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeFile(filePath: string[], content: string): Promise<string> {
    const abs = this.abs(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return abs;
  }

  async writeBinary(filePath: string[], buffer: Buffer, _mimeType?: string): Promise<string> {
    const abs = this.abs(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    return abs;
  }

  async readJson<T>(filePath: string[]): Promise<T | null> {
    const raw = await this.readFile(filePath);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      // A corrupt file must NOT masquerade as "missing": callers treat null as
      // empty-state and would silently overwrite (e.g. appendScoreVersion would
      // reset the whole score history). Surface the corruption instead.
      throw new Error(`Corrupt JSON at ${filePath.join("/")}: ${(e as Error).message}`);
    }
  }

  async writeJson(filePath: string[], data: unknown): Promise<string> {
    return this.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  /** Delete a whole folder subtree. Returns false when it doesn't exist. */
  async deleteFolder(folderPath: string[]): Promise<boolean> {
    const abs = this.abs(folderPath);
    try {
      await fs.rm(abs, { recursive: true });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
