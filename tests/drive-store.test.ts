import { beforeEach, describe, expect, it } from "vitest";
import { DriveStore } from "../apps/cloud/store/drive";
import { FOLDER_MIME, type DriveOps } from "../apps/cloud/store/drive-ops";

/**
 * In-memory DriveOps: a real tree of nodes with parent links, plus an API-call
 * counter so the id-cache behavior is testable. No query-string faking — the
 * fake implements the same narrow interface the googleapis wrapper does.
 */
interface Node {
  id: string;
  name: string;
  parentId: string | null;
  mimeType: string;
  body?: string | Buffer;
}

class FakeDrive implements DriveOps {
  nodes = new Map<string, Node>();
  calls = 0;
  private seq = 0;

  private nid() {
    return `n${++this.seq}`;
  }
  private childrenOf(parentId: string | null) {
    return [...this.nodes.values()].filter((n) => n.parentId === parentId);
  }

  async findFolder(name: string, parentId?: string) {
    this.calls++;
    return (
      this.childrenOf(parentId ?? null).find((n) => n.name === name && n.mimeType === FOLDER_MIME)?.id ?? null
    );
  }
  async createFolder(name: string, parentId?: string) {
    this.calls++;
    const id = this.nid();
    this.nodes.set(id, { id, name, parentId: parentId ?? null, mimeType: FOLDER_MIME });
    return id;
  }
  async findFile(name: string, parentId: string) {
    this.calls++;
    const f = this.childrenOf(parentId).find((n) => n.name === name && n.mimeType !== FOLDER_MIME);
    return f ? { id: f.id, mimeType: f.mimeType } : null;
  }
  async listChildren(parentId: string, kind: "files" | "folders") {
    this.calls++;
    return this.childrenOf(parentId)
      .filter((n) => (kind === "folders" ? n.mimeType === FOLDER_MIME : n.mimeType !== FOLDER_MIME))
      .map((n) => ({ id: n.id, name: n.name, mimeType: n.mimeType }));
  }
  async downloadText(fileId: string) {
    this.calls++;
    const n = this.nodes.get(fileId);
    if (!n) throw new Error("not found");
    return typeof n.body === "string" ? n.body : (n.body as Buffer).toString("utf8");
  }
  async downloadBinary(fileId: string) {
    this.calls++;
    const n = this.nodes.get(fileId);
    if (!n) throw new Error("not found");
    return typeof n.body === "string" ? Buffer.from(n.body) : (n.body as Buffer);
  }
  async createFile(name: string, parentId: string, body: string | Buffer, mimeType: string) {
    this.calls++;
    const id = this.nid();
    this.nodes.set(id, { id, name, parentId, mimeType, body });
    return id;
  }
  async updateFile(fileId: string, body: string | Buffer, mimeType: string) {
    this.calls++;
    const n = this.nodes.get(fileId)!;
    n.body = body;
    n.mimeType = mimeType;
    return fileId;
  }
  async deleteFile(fileId: string) {
    this.calls++;
    // Drive deletes a folder's children with it; mirror that recursively.
    const doomed = new Set([fileId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.nodes.values()) {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    for (const id of doomed) this.nodes.delete(id);
  }
}

let fake: FakeDrive;
let store: DriveStore;

beforeEach(() => {
  fake = new FakeDrive();
  store = new DriveStore(fake);
});

describe("DriveStore semantics (parity with LocalStore)", () => {
  it("round-trips a text file, auto-creating parent folders under the root", async () => {
    await store.writeFile(["applications", "2026-01-01_x_y", "job-ad-snapshot.md"], "# Ad");
    expect(await store.readFile(["applications", "2026-01-01_x_y", "job-ad-snapshot.md"])).toBe("# Ad");
    const folders = [...fake.nodes.values()].filter((n) => n.mimeType === FOLDER_MIME).map((n) => n.name);
    expect(folders).toEqual(expect.arrayContaining(["Kairos", "applications", "2026-01-01_x_y"]));
  });

  it("returns null / [] for missing files and folders", async () => {
    expect(await store.readFile(["nope.md"])).toBeNull();
    expect(await store.readBinary(["nope.bin"])).toBeNull();
    expect(await store.listFiles(["missing-folder"])).toEqual([]);
    expect(await store.listFolders(["missing-folder"])).toEqual([]);
  });

  it("readJson: null when missing, THROW when corrupt", async () => {
    expect(await store.readJson(["_index.json"])).toBeNull();
    await store.writeFile(["_index.json"], "{not json");
    await expect(store.readJson(["_index.json"])).rejects.toThrow(/Corrupt JSON/);
  });

  it("overwrite updates in place (stable id) instead of duplicating", async () => {
    const id1 = await store.writeJson(["application-meta.json"], { v: 1 });
    const id2 = await store.writeJson(["application-meta.json"], { v: 2 });
    expect(id2).toBe(id1);
    expect([...fake.nodes.values()].filter((n) => n.name === "application-meta.json")).toHaveLength(1);
    expect(await store.readJson(["application-meta.json"])).toEqual({ v: 2 });
  });

  it("round-trips binary content", async () => {
    const buf = Buffer.from([80, 75, 3, 4, 0, 255]);
    await store.writeBinary(["applications", "a", "resume.docx"], buf, "application/msword");
    expect((await store.readBinary(["applications", "a", "resume.docx"]))!.equals(buf)).toBe(true);
  });

  it("lists files and folders separately", async () => {
    await store.writeFile(["applications", "app-1", "a.md"], "a");
    await store.writeFile(["applications", "app-2", "b.md"], "b");
    const folders = await store.listFolders(["applications"]);
    expect(folders.map((f) => f.name).sort()).toEqual(["app-1", "app-2"]);
    expect((await store.listFiles(["applications", "app-1"])).map((f) => f.name)).toEqual(["a.md"]);
  });

  it("caches folder + file ids: repeat reads cost fewer API calls", async () => {
    await store.writeFile(["knowledge-base", "experiences", "01-x.md"], "one");
    await store.readFile(["knowledge-base", "experiences", "01-x.md"]);
    const afterFirst = fake.calls;
    await store.readFile(["knowledge-base", "experiences", "01-x.md"]);
    // Within the content-TTL window a repeat read is served entirely from
    // cache: zero API calls (ids AND content are cached; writes write through).
    expect(fake.calls - afterFirst).toBe(0);
  });

  it("initTree creates the standard layout idempotently", async () => {
    await store.initTree();
    const count = fake.nodes.size;
    await store.initTree();
    expect(fake.nodes.size).toBe(count);
    const names = [...fake.nodes.values()].map((n) => n.name);
    expect(names).toEqual(
      expect.arrayContaining(["Kairos", "knowledge-base", "experiences", "education", "applications", "qa-bank"]),
    );
  });
});

describe("DriveStore under the engine tool-core", () => {
  it("runs capture → guarded score-save end to end on Drive", async () => {
    const { createApplication } = await import("@kairos/engine/applications");
    const { saveScoredReport } = await import("@kairos/engine/tools/ops");
    const meta = await createApplication(store, {
      company: "Acme",
      role: "Head of AI",
      snapshotMarkdown: "# Head of AI\nAI strategy and AI strategy delivery.",
    source_url_unavailable: true,
    });
    await saveScoredReport(store, meta.id, "Default résumé", {
      parse_safety: { verdict: "PASS", checks: [], ats_specific_note: "n" },
      match: {
        detected_ats: "x",
        dimensions: [{ name: "hard_skills", score: 70, justification: "j" }],
        overall_band: "COMPETITIVE",
        confidence: "medium",
        pool_caveat: "Band reflects functional fit; true ranking unknowable.",
      },
      authenticity: { score: 90, flags: [], strengths: [] },
      gaps: [],
      reachable: { band_if_tailored: "STRONG", from_reframing: [], needs_user_confirmation: [], honest_ceiling_note: "" },
      recommendation: "APPLY",
    });
    const idx = await store.readJson<{ applications: { id: string; status: string }[] }>(["_index.json"]);
    expect(idx!.applications[0]).toMatchObject({ id: meta.id, status: "scored" });
  });
});
