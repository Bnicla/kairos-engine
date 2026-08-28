/**
 * One-shot migration: mirror a local Kairos tree into the user's REAL Drive
 * (rootName "Kairos"), replacing the content zones — applications,
 * knowledge-base, qa-bank — plus the root content files. Settings, secrets
 * and templates in Drive are left alone.
 *
 *   npm -w kairos-cloud run push-to-drive -- [source-dir]   (default ~/Kairos)
 *
 * Token: uses GOOGLE_ACCESS_TOKEN if set; otherwise runs the app's own OAuth
 * client through a localhost:3002 loopback (the dev redirect URI already
 * registered for Auth.js). The browser opens once; with Drive access already
 * granted, Google redirects straight back without asking anything.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { DriveStore } from "../store/drive";

const CALLBACK_PATH = "/api/auth/callback/google";
const PORT = 3002;
const SKIP = /(^|\/)(\.DS_Store|_render-test)(\/|$)/;
const TEXT_EXT = new Set(["md", "json", "txt"]);
const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
};
const ZONES = ["applications", "knowledge-base", "qa-bank"];

function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

async function getToken(): Promise<string> {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  const env = envLocal();
  const id = env.AUTH_GOOGLE_ID;
  const secret = env.AUTH_GOOGLE_SECRET;
  if (!id || !secret) throw new Error("AUTH_GOOGLE_ID/SECRET missing from apps/cloud/.env.local");
  const redirect = `http://localhost:${PORT}${CALLBACK_PATH}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const c = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h3>Kairos migration authorized. You can close this tab.</h3>");
      server.close();
      if (c) resolve(c);
      else reject(new Error(`Google returned no code: ${url.search}`));
    });
    server.listen(PORT, () => {
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.searchParams.set("client_id", id);
      auth.searchParams.set("redirect_uri", redirect);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "https://www.googleapis.com/auth/drive.file");
      console.log("▸ Waiting for Google consent (browser opening)…");
      execFile("open", [auth.toString()]);
    });
    setTimeout(() => reject(new Error("Timed out waiting for the consent redirect (3 min).")), 180_000);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) throw new Error(`Token exchange failed: ${data.error} ${data.error_description ?? ""}`);
  return data.access_token;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const sourceDir = process.argv[2] ?? join(homedir(), "Kairos");
const files = walk(sourceDir).filter((f) => !SKIP.test(relative(sourceDir, f)));
console.log(`▸ Source: ${sourceDir} (${files.length} files)`);

const store = DriveStore.fromAccessToken(await getToken());

console.log("▸ Deleting cloud content zones:", ZONES.join(", "));
for (const zone of ZONES) {
  const gone = await store.deleteFolder([zone]);
  console.log(`  ${zone}: ${gone ? "deleted" : "was absent"}`);
}

// Pre-create folders sequentially so parallel writes can't race Drive into
// duplicating a folder.
const dirs = [...new Set(files.map((f) => relative(sourceDir, join(f, ".."))).filter((d) => d && d !== "."))].sort();
console.log(`▸ Creating ${dirs.length} folders`);
for (const d of dirs) await store.ensureFolder(d.split("/"));

console.log(`▸ Uploading ${files.length} files`);
let done = 0;
const CONCURRENCY = 6;
for (let i = 0; i < files.length; i += CONCURRENCY) {
  await Promise.all(
    files.slice(i, i + CONCURRENCY).map(async (f) => {
      const rel = relative(sourceDir, f);
      const path = rel.split("/");
      const ext = rel.split(".").pop()!.toLowerCase();
      if (TEXT_EXT.has(ext)) await store.writeFile(path, readFileSync(f, "utf8"), MIME[ext]);
      else await store.writeBinary(path, readFileSync(f), MIME[ext] ?? "application/octet-stream");
      done++;
    }),
  );
  process.stdout.write(`\r  ${done}/${files.length}`);
}
console.log();

const idx = await store.readJson<{ applications: { id: string; status: string }[] }>(["_index.json"]);
const folders = await store.listFolders(["applications"]);
console.log(`▸ Verify: index has ${idx?.applications.length ?? 0} applications, Drive has ${folders.length} folders`);
console.log("✅ Push complete. Refresh kairos-cloud.vercel.app.");
