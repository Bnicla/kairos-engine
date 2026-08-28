// NOTE: intentionally NOT "server-only" — this module is imported by the MCP
// server (raw tsx) as well as the Next app, and the server-only guard throws
// outside Next's bundler. It is server-side by construction (spawns processes).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Visual layout probe: render a .docx to PDF and MEASURE the real page count
 * and last-page fill, instead of estimating from word count. Template-agnostic
 * — it measures whatever the renderer actually produced. Local-only (needs
 * LibreOffice + poppler); returns null when the tooling isn't present, so the
 * engine's word-count gate remains the portable safety net.
 */

const execFileAsync = promisify(execFile);
const SOFFICE = process.env.SOFFICE_PATH ?? "/opt/homebrew/bin/soffice";
const PDFINFO = "/opt/homebrew/bin/pdfinfo";
const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";
// Isolated LibreOffice profile so the probe never pops a visible window and
// never collides with the user's own LibreOffice session.
const LO_PROFILE = "file:///tmp/lo-kairos-probe";
// svp = true headless backend; skips the macOS window server so no Dock/tray
// icon flashes on each render (plain --headless still registers a GUI app).
const HEADLESS_ENV = { ...process.env, SAL_USE_VCLPLUGIN: "svp" };

export interface LayoutProbe {
  pages: number;
  /** Chars on the last page as a fraction of chars on page 1 (0–1+). */
  lastPageFill: number;
  verdict: "good" | "short" | "overflow";
  /** Human-readable, model-actionable guidance when not "good". */
  guidance: string | null;
}

async function toolsPresent(): Promise<boolean> {
  try {
    await execFileAsync("test", ["-x", SOFFICE]);
    await execFileAsync("test", ["-x", PDFINFO]);
    return true;
  } catch {
    return false;
  }
}

/** Measure a rendered resume .docx. Null if the render tools are unavailable. */
export async function probeResumeLayout(docxPath: string): Promise<LayoutProbe | null> {
  if (!(await toolsPresent())) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "kairos-layout-"));
    await execFileAsync(
      SOFFICE,
      ["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
        "--convert-to", "pdf", "--outdir", dir, docxPath],
      { timeout: 90_000, env: HEADLESS_ENV },
    );
    const pdf = (await readdir(dir)).find((f) => f.endsWith(".pdf"));
    if (!pdf) return null;
    const pdfPath = join(dir, pdf);

    const { stdout: info } = await execFileAsync(PDFINFO, [pdfPath], { timeout: 20_000 });
    const pages = parseInt(info.match(/Pages:\s+(\d+)/)?.[1] ?? "0", 10);
    if (pages < 1) return null;

    const chars = async (page: number) => {
      const { stdout } = await execFileAsync(
        PDFTOTEXT, ["-f", String(page), "-l", String(page), pdfPath, "-"],
        { timeout: 20_000 },
      );
      return stdout.replace(/\s/g, "").length;
    };
    const first = await chars(1);
    const last = pages > 1 ? await chars(pages) : first;
    const lastPageFill = first > 0 ? last / first : 1;

    // Target: exactly 2 pages with the second at least ~80% full. 1 page is
    // fine (short careers). 3+ pages, or a sparse final page, need fixing.
    let verdict: LayoutProbe["verdict"] = "good";
    let guidance: string | null = null;
    if (pages > 2) {
      verdict = "overflow";
      guidance = `Rendered to ${pages} pages. Trim the lowest-value bullets from the later roles until it fits exactly 2 pages (remove ~${(pages - 2) * 4}-${(pages - 2) * 6} bullets).`;
    } else if (pages === 2 && lastPageFill < 0.78) {
      verdict = "short";
      const deficit = Math.round((0.85 - lastPageFill) * 12);
      guidance = `Page 2 is only ${Math.round(lastPageFill * 100)}% full. Restore ~${deficit} more curated achievement bullets from the knowledge base (second bullets on later roles), never filler, to fill it.`;
    }
    return { pages, lastPageFill, verdict, guidance };
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
