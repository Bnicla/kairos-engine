import type { ScoreReport } from "@kairos/engine/types";
import type { ScoreVersion } from "@kairos/engine/applications";

/**
 * Three-axis scorecard + before/after comparison for the cloud lane — the same
 * structure as the local dashboard's Scorecard/ScoreCompare, in cloud CSS.
 */

const BAND_TONE: Record<string, string> = {
  STRONG: "tone-success",
  COMPETITIVE: "tone-info",
  DEVELOPING: "tone-warn",
  WEAK: "tone-danger",
};

const REC_LABEL: Record<string, string> = {
  APPLY: "Apply",
  APPLY_AFTER_TAILORING: "Apply after tailoring",
  STRETCH: "Stretch",
  NOT_RECOMMENDED: "Not recommended",
};

const SEV_TONE: Record<string, string> = {
  "DEAL-BREAKER": "tone-danger",
  IMPORTANT: "tone-warn",
  "NICE-TO-HAVE": "tone-neutral",
};

export function BandChip({ band }: { band: string }) {
  return <span className={`badge ${BAND_TONE[band] ?? "tone-neutral"}`}>{band}</span>;
}

function Bar({ value, before }: { value: number; before?: number }) {
  return (
    <div className="bar">
      {before !== undefined && <div className="bar-fill baseline" style={{ width: `${Math.min(100, before)}%` }} />}
      <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function ScoreCompare({ versions }: { versions: ScoreVersion<ScoreReport>[] }) {
  if (versions.length < 2) return null;
  const base = versions[0];
  const opt = versions[versions.length - 1];

  const dimsBase = new Map(base.report.match.dimensions.map((d) => [d.name, d.score]));
  const rows = opt.report.match.dimensions.map((d) => ({
    name: d.name.replace(/_/g, " "),
    before: dimsBase.get(d.name) ?? d.score,
    after: d.score,
  }));
  rows.push({ name: "authenticity", before: base.report.authenticity.score, after: opt.report.authenticity.score });

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: "0.9rem" }}>
        <h2 style={{ margin: 0 }}>Before → after tailoring</h2>
        <span className="chat-stats">
          <BandChip band={base.report.match.overall_band} />
          <span className="muted">→</span>
          <BandChip band={opt.report.match.overall_band} />
        </span>
      </div>
      {rows.map((r) => {
        const delta = r.after - r.before;
        return (
          <div key={r.name} className="compare-row">
            <div className="compare-head">
              <span className="dim-label" style={{ textTransform: "capitalize" }}>{r.name}</span>
              <span className="muted">
                {r.before} → <strong>{r.after}</strong>{" "}
                <span className={`badge ${delta > 0 ? "tone-success" : delta < 0 ? "tone-danger" : "tone-neutral"}`}>
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              </span>
            </div>
            <Bar value={r.after} before={r.before} />
          </div>
        );
      })}
    </div>
  );
}

export default function Scorecard({ report }: { report: ScoreReport }) {
  return (
    <div className="score-detail">
      <div className="card">
        <h2>
          Recommendation:{" "}
          <span className={`badge ${BAND_TONE[report.match.overall_band] ?? ""}`}>
            {REC_LABEL[report.recommendation] ?? report.recommendation}
          </span>
        </h2>
      </div>

      <div className="card">
        <h2>
          Parse safety <span className="badge">deterministic</span>{" "}
          <span className={`badge ${report.parse_safety.verdict === "PASS" ? "tone-success" : "tone-warn"}`}>
            {report.parse_safety.verdict === "PASS" ? "parses cleanly" : "issues found"}
          </span>
        </h2>
        <ul className="muted plain-list">
          {report.parse_safety.checks.map((c, i) => (
            <li key={i}>
              {c.result === "PASS" ? "✓" : c.result === "FAIL" ? "✗" : "?"}{" "}
              <strong>{c.rule.replace(/_/g, " ")}</strong> · {c.detail}
            </li>
          ))}
        </ul>
        {report.parse_safety.ats_specific_note && (
          <p className="muted note">{report.parse_safety.ats_specific_note}</p>
        )}
      </div>

      <div className="card">
        <h2>
          Match <BandChip band={report.match.overall_band} />{" "}
          <span className="badge">{report.match.confidence} confidence</span>
        </h2>
        {report.match.dimensions.map((d) => (
          <div key={d.name} className="compare-row">
            <div className="compare-head">
              <span className="dim-label" style={{ textTransform: "capitalize" }}>{d.name.replace(/_/g, " ")}</span>
              <span className="muted">{d.score}</span>
            </div>
            <Bar value={d.score} />
            <p className="muted dim-just">{d.justification}</p>
          </div>
        ))}
        <p className="muted note">{report.match.pool_caveat}</p>
      </div>

      <div className="card">
        <h2>Authenticity</h2>
        <p style={{ margin: "0.2rem 0 0.6rem" }}>
          <span style={{ fontSize: "1.5rem", fontWeight: 700 }}>{report.authenticity.score}</span>
          <span className="muted"> / 100 · higher reads as authentically human</span>
        </p>
        {report.authenticity.flags.length > 0 && (
          <ul className="muted plain-list">
            {report.authenticity.flags.map((f, i) => (
              <li key={i}>
                ⚑ <strong>{f.issue.replace(/_/g, " ")}</strong> · {f.detail}
                {f.where ? ` (${f.where})` : ""}
              </li>
            ))}
          </ul>
        )}
        {report.authenticity.strengths.length > 0 && (
          <ul className="muted fixes" style={{ marginTop: "0.4rem" }}>
            {report.authenticity.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
      </div>

      {report.gaps.length > 0 && (
        <div className="card">
          <h2>Gaps, named plainly</h2>
          {report.gaps.map((g, i) => (
            <div key={i} className="gap-item">
              <div>
                <span className={`badge ${SEV_TONE[g.severity] ?? ""}`}>{g.severity.toLowerCase()}</span>{" "}
                <strong>{g.requirement}</strong>
              </div>
              <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                {g.type === "possibly_uncaptured"
                  ? "Possibly in your experience but not captured yet. Answer it in the conversation below."
                  : "Genuine gap."}
                {g.clarifying_question && g.type === "possibly_uncaptured" ? ` ${g.clarifying_question}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>
          Reachable after tailoring <BandChip band={report.reachable.band_if_tailored} />
        </h2>
        {report.reachable.from_reframing.length > 0 && (
          <>
            <p className="muted" style={{ margin: "0.4rem 0 0.2rem", fontWeight: 600 }}>By reframing existing evidence</p>
            <ul className="muted fixes">
              {report.reachable.from_reframing.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        )}
        {report.reachable.needs_user_confirmation.length > 0 && (
          <>
            <p className="muted" style={{ margin: "0.6rem 0 0.2rem", fontWeight: 600 }}>Needs you to confirm new facts</p>
            <ul className="muted fixes">
              {report.reachable.needs_user_confirmation.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        )}
        <p className="muted note">{report.reachable.honest_ceiling_note}</p>
      </div>
    </div>
  );
}
