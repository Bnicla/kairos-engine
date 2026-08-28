// NOT "server-only": imported by both the Next app and any tsx context. Shells
// out to the Claude Code CLI in headless (-p) mode for Max-billed model calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const CLAUDE = () => process.env.CLAUDE_CLI_PATH ?? join(homedir(), ".local/bin/claude");
// Long-lived headless token minted via `claude setup-token`. The interactive
// OAuth session isn't visible to a dev-server or cron process, so we read the
// token from this 0600 file and inject it — the same file daily-routine.sh uses.
const TOKEN_FILE = process.env.KAIROS_TOKEN_FILE ?? join(homedir(), ".config/kairos/claude-oauth-token");

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const tok = readFileSync(TOKEN_FILE, "utf8").replace(/\s+/g, "");
      if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    } catch {
      /* no token file: fall back to whatever ambient auth exists */
    }
  }
  return env;
}

/** Run a headless Claude prompt and return stdout. Throws on non-zero exit. */
export async function runClaude(prompt: string, timeoutMs = 10 * 60_000): Promise<string> {
  const { stdout } = await execFileAsync(CLAUDE(), ["-p", prompt], {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: claudeEnv(),
  });
  return stdout;
}
