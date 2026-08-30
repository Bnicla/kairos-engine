/**
 * Outcome calibration runner: reads every application in the store and answers
 * the question the scorer must be judged on — do predicted bands track real
 * interview conversion?
 *
 *   npm run eval:calibration                    (reads ~/Kairos, or KAIROS_HOME)
 *   npm run eval:calibration -- --json          (machine-readable)
 *
 * Free to run (no model calls). Prints an aggregate table only — bands, counts,
 * rates, intervals. No company names or application identifiers, so the output
 * is publishable without leaking the pipeline.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeCalibration,
  toCalibrationInput,
  type BandRow,
} from "@kairos/engine/calibration";

const KAIROS = process.env.KAIROS_HOME ?? join(homedir(), "Kairos");
const APPS = join(KAIROS, "applications");

if (!existsSync(APPS)) {
  console.error(`No applications directory at ${APPS} (set KAIROS_HOME to point elsewhere).`);
  process.exit(1);
}

const inputs = readdirSync(APPS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const p = join(APPS, d.name, "application-meta.json");
    if (!existsSync(p)) return [];
    try {
      return [toCalibrationInput(JSON.parse(readFileSync(p, "utf8")))];
    } catch {
      console.error(`! unreadable meta skipped: ${d.name}`);
      return [];
    }
  });

const report = computeCalibration(inputs);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (x: number | null) => (x === null ? "   —" : `${Math.round(x * 100)}%`.padStart(4));
const ci = (c: [number, number] | null) =>
  c === null ? "          " : `[${Math.round(c[0] * 100)}–${Math.round(c[1] * 100)}%]`.padStart(10);

function printRows(title: string, rows: BandRow[]) {
  console.log(`\n${title}`);
  console.log("  band/rec              applied  interviews  no-interview  pending  decided-rate  95% CI      conservative");
  for (const r of rows) {
    console.log(
      `  ${r.band.padEnd(22)}${String(r.applied).padStart(5)}${String(r.interviews).padStart(11)}${String(r.rejectedOrExpired).padStart(13)}${String(r.pending).padStart(9)}  ${pct(r.decidedRate).padStart(10)}  ${ci(r.decidedCI)}  ${pct(r.conservativeRate).padStart(10)}`,
    );
  }
}

console.log("KAIROS SCORER CALIBRATION — predicted band vs real interview conversion");
console.log(`applications applied: ${report.totalApplied} · interviews reached: ${report.totalInterviews} · pending: ${report.totalPending} · withdrawn (censored): ${report.totalWithdrawn}`);
printRows("By predicted band:", report.byBand);
printRows("By recommendation:", report.byRecommendation);
console.log(
  `\nBand ordering monotone on decided outcomes: ${report.monotone === null ? "not enough data" : report.monotone ? "YES — better bands convert better" : "NO — calibration gap, investigate"}`,
);
for (const c of report.caveats) console.log(`caveat: ${c}`);
