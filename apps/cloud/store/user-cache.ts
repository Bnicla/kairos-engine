import type { FileEntry, FolderEntry } from "@kairos/engine/store/types";

/**
 * Cross-request Drive cache, one per user (module-global, so it survives across
 * requests on a warm serverless instance). Drive addresses by id and every hop
 * is a network call; per-request caches meant EVERY navigation re-resolved the
 * whole folder tree, which was most of the perceived slowness.
 *
 * Safety model:
 *  - folder/file IDs are stable (overwrites are files.update; this app is the
 *    only writer in its drive.file scope) → cached for the cache's lifetime,
 *    with a self-heal retry in DriveStore if an id goes stale externally.
 *  - content + listings are freshness-sensitive → short TTL, and writes through
 *    the same cache invalidate them immediately.
 */
export interface DriveCache {
  folderIds: Map<string, string>;
  fileIds: Map<string, string>;
  content: Map<string, { value: string | null; at: number }>;
  lists: Map<string, { value: FileEntry[] | FolderEntry[]; at: number }>;
  createdAt: number;
}

/** Content/listing freshness window. */
export const CONTENT_TTL_MS = 15_000;
/** Whole-cache lifetime (guards against externally deleted/moved files). */
const CACHE_LIFE_MS = 30 * 60_000;
const MAX_USERS = 500;

const caches = new Map<string, DriveCache>();

export function driveCacheFor(userKey: string): DriveCache {
  const now = Date.now();
  const hit = caches.get(userKey);
  if (hit && now - hit.createdAt < CACHE_LIFE_MS) return hit;

  const fresh: DriveCache = {
    folderIds: new Map(),
    fileIds: new Map(),
    content: new Map(),
    lists: new Map(),
    createdAt: now,
  };
  caches.set(userKey, fresh);
  if (caches.size > MAX_USERS) {
    // Drop the oldest entry; plain Map iteration order is insertion order.
    const oldest = caches.keys().next().value;
    if (oldest !== undefined) caches.delete(oldest);
  }
  return fresh;
}
