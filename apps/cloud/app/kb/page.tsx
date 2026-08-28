import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../lib/session";
import { loadExperiences, loadEducation } from "@kairos/engine/kb/store";
import { stripProvenanceTags } from "@kairos/engine/kb/experience";
import type { HealthReport } from "@kairos/engine/health";
import type { Experience } from "@kairos/engine/kb/types";

export const dynamic = "force-dynamic";

const KB = "knowledge-base";

function bullets(body: string, max = 3): string[] {
  return body
    .split("\n")
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => stripProvenanceTags(l.replace(/^\s*-\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")))
    .slice(0, max);
}

export default async function KnowledgeBase({
  searchParams,
}: {
  searchParams: Promise<{ fresh?: string }>;
}) {
  const { fresh } = await searchParams;
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");

  let experiences: Experience[] = [];
  let education: string[] = [];
  let health: HealthReport | null = null;
  try {
    [experiences, education, health] = await Promise.all([
      loadExperiences(ctx.store),
      loadEducation(ctx.store),
      ctx.store.readJson<HealthReport>([KB, "_health.json"]),
    ]);
  } catch {
    // Tree absent — fall through to the empty state.
  }

  if (experiences.length === 0) {
    return (
      <main>
        <div className="hero">
          <h1>Your knowledge base</h1>
          <p className="lede">Nothing here yet. It's built from your résumé in one step.</p>
        </div>
        <div className="card">
          <p>
            <Link href="/onboard">Upload your résumé to build it →</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="hero">
        <h1>Your knowledge base</h1>
        <p className="lede">
          {experiences.length} role{experiences.length === 1 ? "" : "s"} extracted from your
          résumé, stored in your Drive. Every fact is provenance-tagged.
        </p>
      </div>

      {fresh && (
        <div className="card flash-ok">
          ✓ Knowledge base built. Here's your first deliverable: an honest health report.
        </div>
      )}

      {health && (
        <div className="card">
          <div className="health-head">
            <div className="health-score">
              <span className="n">{health.overall}</span>
              <span className="d">/100</span>
            </div>
            <div>
              <h2>
                Résumé health{" "}
                {health.stage && (
                  <span className="badge" title="Thresholds calibrate to your experience level">
                    {health.stage === "early" ? "early-career curve" : health.stage === "mid" ? "mid-career curve" : "senior curve"}
                  </span>
                )}
              </h2>
              <p className="muted">{health.verdict}</p>
            </div>
          </div>

          <div className="dims">
            {health.dimensions.map((d) => (
              <div key={d.key} className="dim-row">
                <span className={`badge ${d.status === "strong" ? "ok" : d.status === "weak" ? "todo" : ""}`}>
                  {d.score}/5
                </span>
                <span className="dim-label">{d.label}</span>
                <span className="muted dim-detail">{d.detail}</span>
              </div>
            ))}
          </div>

          {health.topFixes.length > 0 && (
            <>
              <h2 style={{ marginTop: "1.2rem" }}>Top fixes</h2>
              <ol className="muted fixes">
                {health.topFixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}

      {experiences.map((exp) => {
        const confirmed = (exp.body.match(/\[C\]/g) ?? []).length;
        return (
        <div key={exp.fileName} className="card">
          <h2>
            {exp.frontmatter.title} · {exp.frontmatter.company}{" "}
            <span className="badge">
              {exp.frontmatter.start}–{exp.frontmatter.end}
            </span>{" "}
            {confirmed > 0 && <span className="badge ok">{confirmed} confirmed</span>}
          </h2>
          <p className="muted">
            {[exp.frontmatter.seniority_level, ...(exp.frontmatter.domains ?? []).slice(0, 3)]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <ul className="muted kb-bullets">
            {bullets(exp.body).map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {(exp.frontmatter.skills ?? []).length > 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Skills: {(exp.frontmatter.skills ?? []).map((s) => s.name).slice(0, 8).join(", ")}
            </p>
          )}
          <Link href={`/enrich/${encodeURIComponent(exp.fileName)}`}>
            {confirmed > 0 ? "Keep going deeper →" : "Go deeper on this role →"}
          </Link>
        </div>
        );
      })}

      {education.length > 0 && (
        <div className="card">
          <h2>Education</h2>
          {education.map((raw) => {
            const inst = raw.match(/institution:\s*"?([^"\n]+)"?/)?.[1];
            const cred = raw.match(/credential:\s*"?([^"\n]+)"?/)?.[1];
            return (
              <p key={raw.slice(0, 60)} className="muted">
                {[inst, cred].filter(Boolean).join(" · ") || "Education entry"}
              </p>
            );
          })}
        </div>
      )}

      <p className="footnote">
        <Link href="/onboard">Re-upload a résumé</Link> (replaces this extraction) ·{" "}
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
