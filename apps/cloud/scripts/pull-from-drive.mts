/**
 * Reverse sync: pull specific application folders from the user's REAL Drive
 * (rootName "Kairos") back into the local tree (~/Kairos). Recovery tool for
 * locally purged applications that still exist in Drive.
 *
 *   npm -w kairos-cloud run pull-from-drive -- <appFolderName> [more...]
 *
 * Token: GOOGLE_ACCESS_TOKEN env, or the app's own OAuth client through the
 * localhost:3002 loopback (same flow as push-to-drive).
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DriveStore } from "../store/drive";

const CALLBACK_PATH = "/api/auth/callback/google";
const PORT = 3002;
const BINARY_EXT = new Set(["docx", "pdf", "png", "zip"]);

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
      if (url.pathname !== CALLBACK_PATH) return void res.writeHead(404).end();
      const c = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h3>Kairos recovery authorized. You can close this tab.</h3>");
      server.close();
      c ? resolve(c) : reject(new Error(`Google returned no code: ${url.search}`));
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
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) throw new Error(`Token exchange failed: ${data.error} ${data.error_description ?? ""}`);
  return data.access_token;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: npm -w kairos-cloud run pull-from-drive -- <appFolderName> [more...]");
  process.exit(1);
}

const store = DriveStore.fromAccessToken(await getToken());
const driveFolders = new Set((await store.listFolders(["applications"])).map((f) => f.name));
const localRoot = join(homedir(), "Kairos");

for (const appId of targets) {
  if (!driveFolders.has(appId)) {
    console.log(`✗ ${appId}: NOT in Drive either — unrecoverable from here (check Drive trash at drive.google.com).`);
    continue;
  }
  const files = await store.listFiles(["applications", appId]);
  const dir = join(localRoot, "applications", appId);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const ext = f.name.split(".").pop()!.toLowerCase();
    if (BINARY_EXT.has(ext)) {
      const buf = await store.readBinary(["applications", appId, f.name]);
      if (buf) writeFileSync(join(dir, f.name), buf);
    } else {
      const text = await store.readFile(["applications", appId, f.name]);
      if (text !== null) writeFileSync(join(dir, f.name), text, "utf8");
    }
    console.log(`  ↓ ${appId}/${f.name}`);
  }
  console.log(`✓ ${appId}: ${files.length} files restored`);
}
console.log("\nDone. The board index self-heals on next load (folders now outnumber entries).");
