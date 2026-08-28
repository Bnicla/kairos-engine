import JSZip from "jszip";
import type { TemplateSpec } from "@kairos/engine/docx-render";

/**
 * Parse an uploaded .docx TEMPLATE into design overrides (DEC-8). Extracts only
 * visual style — font, base size, page margins, ink color — never content. The
 * result is a Partial<TemplateSpec> merged over DEFAULT_TEMPLATE at render
 * time, so a student's résumés come out in their own design, not the app
 * author's. Anything we can't confidently read is left to the default.
 */
export interface ParsedTemplate {
  overrides: Partial<TemplateSpec>;
  /** What was actually detected, for the UI to confirm with the user. */
  detected: string[];
}

export async function parseDocxTemplate(buffer: Buffer): Promise<ParsedTemplate> {
  const zip = await JSZip.loadAsync(buffer);
  const overrides: Partial<TemplateSpec> = {};
  const detected: string[] = [];

  const styles = await zip.file("word/styles.xml")?.async("string");
  if (styles) {
    // Default run properties: font + size + color.
    const defaults = styles.match(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/)?.[1] ?? "";
    const font = defaults.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/)?.[1];
    if (font) {
      overrides.font = font;
      detected.push(`font: ${font}`);
    }
    const size = defaults.match(/<w:sz[^>]*w:val="(\d+)"/)?.[1];
    if (size) {
      const halfPoints = parseInt(size, 10);
      // Sanity: base text between 8pt and 14pt.
      if (halfPoints >= 16 && halfPoints <= 28) {
        overrides.base = halfPoints;
        detected.push(`base size: ${halfPoints / 2}pt`);
      }
    }
    const color = defaults.match(/<w:color[^>]*w:val="([0-9A-Fa-f]{6})"/)?.[1];
    if (color && color.toUpperCase() !== "000000" && color.toUpperCase() !== "AUTO") {
      overrides.ink = color.toUpperCase();
      detected.push(`text color: #${color.toUpperCase()}`);
    }
  }

  const document = await zip.file("word/document.xml")?.async("string");
  if (document) {
    const margin = document.match(/<w:pgMar[^>]*w:top="(\d+)"[^>]*w:right="(\d+)"/);
    if (margin) {
      const top = parseInt(margin[1], 10);
      // Sanity: between 0.3" and 1.5".
      if (top >= 432 && top <= 2160) {
        overrides.pageMarginTwips = top;
        detected.push(`page margin: ${(top / 1440).toFixed(2)}"`);
      }
    }

    // Run-level majority vote. Google Docs exports and hand-formatted Word docs
    // set fonts/sizes on RUNS and leave the style default at Calibri, so the
    // styles.xml read above misses the real design. The document itself is the
    // ground truth: the most common run font/size IS the template's body style.
    const runFonts = countMatches(document, /<w:rFonts[^>]*w:ascii="([^"]+)"/g);
    const majorityFont = majority(runFonts, 5);
    if (majorityFont && majorityFont !== overrides.font) {
      overrides.font = majorityFont;
      const i = detected.findIndex((d) => d.startsWith("font:"));
      if (i !== -1) detected.splice(i, 1);
      detected.push(`font: ${majorityFont}`);
    }

    const runSizes = countMatches(document, /<w:sz [^>]*w:val="(\d+)"/g);
    const bodySize = majority(runSizes, 5, (v) => {
      const n = parseInt(v, 10);
      return n >= 16 && n <= 28; // body text 8-14pt
    });
    if (bodySize) {
      overrides.base = parseInt(bodySize, 10);
      const i = detected.findIndex((d) => d.startsWith("base size:"));
      if (i !== -1) detected.splice(i, 1);
      detected.push(`base size: ${parseInt(bodySize, 10) / 2}pt`);
    }

    // Largest size in the doc is almost always the candidate's name.
    const nameSize = Math.max(0, ...[...runSizes.keys()].map((v) => parseInt(v, 10)));
    if (nameSize >= 28 && nameSize <= 72) {
      overrides.name = nameSize;
      detected.push(`name size: ${nameSize / 2}pt`);
    }
  }

  return { overrides, detected };
}

function countMatches(xml: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of xml.matchAll(re)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

/** The most frequent value, if it occurs at least `min` times (and passes the filter). */
function majority(
  counts: Map<string, number>,
  min: number,
  filter: (v: string) => boolean = () => true,
): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (!filter(v)) continue;
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return bestN >= min ? best : null;
}
