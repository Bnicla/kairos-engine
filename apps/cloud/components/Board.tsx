"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { STATUS_META, type IndexEntry } from "@kairos/engine/applications";
import { STAGES, groupByStage, staleSignal } from "@kairos/engine/pipeline";
import { archiveAction } from "../app/actions";

export interface SourcedCard {
  company: string;
  title: string;
  url: string;
  location: string;
  age_days: number | null;
  location_fit: "match" | "stretch";
  guess_band?: string;
  one_liner?: string;
  /** Harvested application-form info (Greenhouse boards only; null = not coverable). */
  form?: { writing_questions: number; needs_cover_letter: boolean } | null;
}

/** The pipeline board with an instant client-side search over company + role. */
export default function Board({
  apps,
  sourced = [],
  sourcedRanAt,
}: {
  apps: IndexEntry[];
  sourced?: SourcedCard[];
  sourcedRanAt?: string;
}) {
  const [query, setQuery] = useState("");
  const [sourcing, setSourcing] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  async function sourceJobs() {
    setSourcing(true);
    setSourceError(null);
    try {
      const res = await fetch("/api/source", { method: "POST", body: "{}" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Sweep failed. Try again.");
      window.location.reload();
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : "Sweep failed. Try again.");
      setSourcing(false);
    }
  }
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? apps.filter((a) => `${a.company} ${a.role}`.toLowerCase().includes(q)) : apps),
    [apps, q],
  );
  const filteredSourced = useMemo(
    () => (q ? sourced.filter((s) => `${s.company} ${s.title}`.toLowerCase().includes(q)) : sourced),
    [sourced, q],
  );
  const byStage = groupByStage(filtered);
  const nowIso = new Date().toISOString();

  return (
    <>
      <div className="board-search">
        <button
          type="button"
          className="button-link"
          onClick={sourceJobs}
          disabled={sourcing}
          title="Sweep 6,000+ company job boards for fresh roles matching your sourcing preferences (a few minutes, runs on your API key)"
          style={{ whiteSpace: "nowrap" }}
        >
          {sourcing ? "Sweeping…" : "⌁ Source jobs"}
        </button>
        {sourceError && <span className="muted" role="alert">⚠ {sourceError}</span>}
        <span className="board-search-icon">⌕</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Search company or role…"
          aria-label="Search applications"
        />
        {q && (
          <span className="board-search-count muted">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>
      <div className={sourced.length > 0 ? "board board-5" : "board"}>
        {sourced.length > 0 && (
          <div className="board-col">
            <div className="board-col-head">
              Sourced <span className="muted">{filteredSourced.length}</span>
            </div>
            {filteredSourced.map((s) => (
              <div key={s.url} className="board-card sourced-card">
                {/* Same hierarchy as every other column: company on top, role below. */}
                <a href={s.url} target="_blank" rel="noreferrer" title="Open the job ad in a new tab">
                  <div className="bc-role" style={{ color: "var(--accent)", fontWeight: 600 }}>
                    {s.company} ↗
                  </div>
                </a>
                <div className="bc-company">{s.title}</div>
                <div className="bc-badges">
                  <span className="badge">
                    {s.age_days === null ? "date n/a" : s.age_days === 0 ? "today" : `${s.age_days}d ago`}
                  </span>
                  {s.guess_band && (
                    <span
                      className={`badge tone-${s.guess_band === "STRONG" ? "success" : s.guess_band === "COMPETITIVE" ? "info" : "warn"}`}
                      title="Triage guess, not a real score"
                    >
                      {s.guess_band.toLowerCase()}?
                    </span>
                  )}
                  {s.location_fit === "stretch" && <span className="badge tone-warn">stretch</span>}
                  {s.form && s.form.writing_questions > 0 && (
                    <span className="badge" title="Written questions on the application form (beyond standard fields)">
                      {s.form.writing_questions} written q
                    </span>
                  )}
                  {s.form?.needs_cover_letter && (
                    <span className="badge tone-warn" title="The form requires a cover letter">letter req.</span>
                  )}
                </div>
                {s.one_liner && <div className="muted bc-date">{s.one_liner}</div>}
                <div className="muted bc-date">{s.location || "—"}</div>
                <Link
                  href={`/applications/new?url=${encodeURIComponent(s.url)}`}
                  className="bc-date"
                  title="Capture and score this job"
                >
                  Track →
                </Link>
              </div>
            ))}
            {sourcedRanAt && <div className="muted bc-date">run {sourcedRanAt.slice(0, 16).replace("T", " ")}</div>}
          </div>
        )}
        {STAGES.map((stage) => (
          <div key={stage.key} className="board-col">
            <div className="board-col-head">
              {stage.label} <span className="muted">{byStage[stage.key].length}</span>
            </div>
            {byStage[stage.key].map((a) => {
              const stale = staleSignal(a, nowIso);
              const date = a.applied_at
                ? `applied ${a.applied_at.slice(0, 10)}`
                : `captured ${a.captured_at.slice(0, 10)}`;
              return (
                <div key={a.id} className="board-card-slot">
                  <Link href={`/applications/${encodeURIComponent(a.id)}`} className="board-card">
                    <div className="bc-role" style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {a.company}
                    </div>
                    <div className="bc-company">{a.role}</div>
                    <div className="bc-badges">
                      <span className={`badge tone-${STATUS_META[a.status].tone}`}>
                        {STATUS_META[a.status].label}
                      </span>
                      {a.score_band && <span className="badge">{a.score_band}</span>}
                    </div>
                    {stale && <div className={`bc-stale tone-${stale.tone}`}>{stale.text}</div>}
                    <div className="muted bc-date">{date}</div>
                  </Link>
                  {stage.key === "closed" && (
                    <form action={archiveAction} className="bc-archive">
                      <input type="hidden" name="appId" value={a.id} />
                      <input type="hidden" name="archived" value="1" />
                      <button className="linklike" title="Move to the archive (nothing is deleted)">
                        Archive
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
