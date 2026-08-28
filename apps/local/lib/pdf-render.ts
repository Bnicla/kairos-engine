// NOTE: intentionally NOT "server-only" — imported by the MCP server (raw tsx)
// as well as the Next app; the server-only guard throws outside Next's bundler.
// Server-side by construction (spawns LibreOffice).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename, rm, readdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

/**
 * Render a .docx to a PDF sitting next to it (same directory, same stem).
 *
 * Every application keeps BOTH: the .docx is the editable master for quick
 * manual tuning, the .pdf is the faithful, submit-ready render of that exact
 * layout (LibreOffice, so Calibri / spacing / page breaks match the docx — not
 * the separate HTML template). Best-effort: returns false when LibreOffice is
 * absent so callers never fail a save just because the PDF couldn't be made.
 */

const execFileAsync = promisify(execFile);
const SOFFICE = process.env.SOFFICE_PATH ?? "/opt/homebrew/bin/soffice";
// Isolated profile so conversion never pops a window or collides with the
// user's own LibreOffice session. Distinct from the layout probe's profile so
// the two can run concurrently without locking each other out.
const LO_PROFILE = "file:///tmp/lo-kairos-pdf";
// svp = LibreOffice's true headless display backend: it never touches the macOS
// window server, so no icon flashes into the Dock/app tray on each conversion
// (plain --headless still registers a GUI app on macOS and bounces the Dock).
const HEADLESS_ENV = { ...process.env, SAL_USE_VCLPLUGIN: "svp" };

async function sofficePresent(): Promise<boolean> {
  try {
    await execFileAsync("test", ["-x", SOFFICE]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert `docxPath` → sibling `.pdf`. Returns the pdf path on success, null if
 * LibreOffice is unavailable or the conversion failed.
 */
export async function renderDocxToPdf(docxPath: string): Promise<string | null> {
  if (!(await sofficePresent())) return null;
  const outDir = dirname(docxPath);
  const stem = basename(docxPath).replace(/\.docx$/i, "");
  const wantPdf = join(outDir, `${stem}.pdf`);
  try {
    await execFileAsync(
      SOFFICE,
      ["--headless", "--invisible", "--norestore", `-env:UserInstallation=${LO_PROFILE}`,
        "--convert-to", "pdf", "--outdir", outDir, docxPath],
      { timeout: 90_000, env: HEADLESS_ENV },
    );
    // soffice names the output after the input stem; confirm it landed.
    const produced = (await readdir(outDir)).find(
      (f) => f.toLowerCase() === `${stem.toLowerCase()}.pdf`,
    );
    if (!produced) return null;
    if (produced !== `${stem}.pdf`) {
      await rename(join(outDir, produced), wantPdf).catch(() => {});
    }
    return wantPdf;
  } catch {
    await rm(wantPdf, { force: true }).catch(() => {});
    return null;
  }
}
