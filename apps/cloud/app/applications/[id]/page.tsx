import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../../lib/session";
import {
  readConversation,
  readMeta,
  readScoreReport,
  readScoreVersions,
  readSnapshot,
  STATUS_META,
  ALL_STATUSES,
  type ApplicationMeta,
} from "@kairos/engine/applications";
import type { ScoreReport } from "@kairos/engine/types";
import { isWritingQuestion, readApplicationForm } from "@kairos/engine/forms";
import { archiveAction, deleteApplicationAction, generateCoverLetterAction, generateResumeAction, progressAction } from "../../actions";
import SubmitButton from "../../../components/SubmitButton";
import TailorChat from "../../../components/TailorChat";
import Scorecard, { BandChip, ScoreCompare } from "../../../components/Scorecard";
import type { GenerationOutcome } from "../../../lib/apps-agent";
import type { ChatMessage } from "../../../lib/enrich-agent";

export const dynamic = "force-dynamic";
// Résumé generation (with repair rounds) can take a few minutes.
export const maxDuration = 300;

/** The sensible next steps from each status — first entry renders as primary. */
const NEXT_ACTIONS: Record<string, [string, string][]> = {
  captured: [["applied", "Mark applied"], ["withdrawn", "Withdraw"]],
  scored: [["applied", "Mark applied"], ["withdrawn", "Withdraw"]],
  drafted: [["applied", "Mark applied"], ["withdrawn", "Withdraw"]],
  applied: [["interviewing", "Interviewing →"], ["rejected", "Rejected"], ["withdrawn", "Withdraw"]],
  interviewing: [["offer", "Offer →"], ["rejected", "Rejected"], ["withdrawn", "Withdraw"]],
  offer: [["rejected", "Rejected"], ["withdrawn", "Declined"]],
  rejected: [["applied", "Reopen as applied"]],
  withdrawn: [["applied", "Reopen as applied"]],
};

const NEXT_HINT: Record<string, string> = {
  drafted: "sent it off? Attach the file you actually sent and mark applied.",
  applied: "move it forward when you hear back, or close it out.",
  interviewing: "interview prep is below.",
};

export default async function ApplicationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; e?: string }>;
}) {
  const { id } = await params;
  const { ok, e } = await searchParams;
  const appId = decodeURIComponent(id);

  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");

  const meta = await readMeta(ctx.store, appId);
  if (!meta) redirect("/applications");

  const stage = STATUS_META[meta!.status].stage;

  const [report, versions, genReport, conversation, prepConversation, snapshot, coverLetter, questions, form] = await Promise.all([
    readScoreReport<ScoreReport>(ctx.store, appId),
    readScoreVersions<ScoreReport>(ctx.store, appId),
    ctx.store.readJson<GenerationOutcome>(["applications", appId, "generation-report.json"]),
    // Only the stage's own transcript is loaded; the other stays untouched in Drive.
    stage === "draft" ? readConversation<{ messages: ChatMessage[] }>(ctx.store, appId) : Promise.resolve(null),
    stage === "ongoing"
      ? ctx.store.readJson<{ messages: ChatMessage[] }>(["applications", appId, "interview-prep.json"])
      : Promise.resolve(null),
    readSnapshot(ctx.store, appId),
    ctx.store.readFile(["applications", appId, "cover-letter.md"]),
    ctx.store.readJson<{ question: string; answer: string }[]>(["applications", appId, "questions.json"]),
    readApplicationForm(ctx.store, appId),
  ]);
  const hasResume = genReport !== null;
  const hasLetter = coverLetter !== null;

  return (
    <main>
      {/* Header */}
      <div className="hero" style={{ marginBottom: "0.4rem" }}>
        <p className="muted" style={{ margin: "0 0 0.3rem", fontSize: "0.8rem" }}>
          <Link href="/">← Board</Link>
        </p>
        <div className="row-between">
          <div>
            <h1 style={{ margin: 0 }}>{meta!.role}</h1>
            <p className="muted" style={{ margin: "0.2rem 0 0" }}>
              {meta!.company}
              {meta!.source_url && (
                <>
                  {" · "}
                  <a href={meta!.source_url} target="_blank" rel="noreferrer">
                    job posting ↗
                  </a>
                </>
              )}
              {meta!.applied_at && <> · applied {meta!.applied_at.slice(0, 10)}</>}
            </p>
          </div>
          <span className={`badge tone-${STATUS_META[meta!.status].tone}`}>
            {STATUS_META[meta!.status].label}
          </span>
        </div>
      </div>

      {ok && <div className="card flash-ok">✓ {ok}</div>}
      {e && <div className="card flash-err">⚠ {e}</div>}

      {/* Status — one card, one form: next-step buttons + optional note + optional sent file */}
      <div className="card">
        <h2 className="section-label">Status</h2>
        <p className="muted" style={{ margin: "0 0 0.8rem", fontSize: "0.85rem" }}>
          {STATUS_META[meta!.status].label}
          {meta!.applied_at && ` · applied ${meta!.applied_at.slice(0, 10)}`}
          {meta!.submitted_file && (
            <>
              {" · "}
              <a href={`/api/download?app=${encodeURIComponent(meta!.id)}&file=${encodeURIComponent(meta!.submitted_file)}`}>
                sent file ↓
              </a>
            </>
          )}
          {NEXT_HINT[meta!.status] && `. ${NEXT_HINT[meta!.status]}`}
        </p>

        <form action={progressAction}>
          <input type="hidden" name="appId" value={meta!.id} />
          <div className="status-form" style={{ flexWrap: "wrap", marginBottom: "0.7rem" }}>
            <input
              type="text"
              name="note"
              placeholder="Note (optional), e.g. recruiter call, rejection email"
              style={{ margin: 0, flex: 1, minWidth: "14rem" }}
            />
            <label className="field-label" style={{ flexDirection: "row", alignItems: "center", gap: "0.4rem" }}>
              {meta!.submitted_file ? "Replace sent file:" : stage === "draft" ? "Attach what you send:" : "Attach sent file:"}
              <input type="file" name="sent_file" accept=".docx,.pdf" style={{ margin: 0, width: "auto" }} />
            </label>
          </div>
          <div className="doc-actions">
            {NEXT_ACTIONS[meta!.status].map(([status, label], i) => (
              <SubmitButton key={status} name="status" value={status} secondary={i > 0} pendingLabel="Saving…">
                {label}
              </SubmitButton>
            ))}
            {(meta!.submitted_file || stage !== "draft") && (
              <SubmitButton secondary name="status" value="" pendingLabel="Saving…">
                Save note/file only
              </SubmitButton>
            )}
          </div>
        </form>

        <details className="help" style={{ marginTop: "0.8rem", display: "block" }}>
          <summary style={{ width: "auto", padding: "0 0.6rem" }}>More options</summary>
          <form action={progressAction} className="status-form" style={{ marginTop: "0.6rem" }}>
            <input type="hidden" name="appId" value={meta!.id} />
            <select name="status" defaultValue={meta!.status}>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
            <SubmitButton secondary pendingLabel="Saving…">
              Set status
            </SubmitButton>
          </form>

          <div className="status-form" style={{ marginTop: "0.8rem", alignItems: "center" }}>
            {(stage === "closed" || meta!.archived) && (
              <form action={archiveAction}>
                <input type="hidden" name="appId" value={meta!.id} />
                <input type="hidden" name="archived" value={meta!.archived ? "0" : "1"} />
                <SubmitButton secondary pendingLabel="Saving…">
                  {meta!.archived ? "Restore from archive" : "Archive (hide from the board)"}
                </SubmitButton>
              </form>
            )}
            <details className="help" style={{ display: "inline-block" }}>
              <summary style={{ width: "auto", padding: "0 0.6rem" }}>Delete this application…</summary>
              <div className="pop">
                <p className="muted" style={{ margin: "0 0 0.6rem" }}>
                  Removes the whole folder from your Drive: job ad, scores, résumé, cover letter.
                  There's no undo. If you might come back to it, archive instead.
                </p>
                <form action={deleteApplicationAction}>
                  <input type="hidden" name="appId" value={meta!.id} />
                  <SubmitButton secondary pendingLabel="Deleting from your Drive…">
                    Delete forever
                  </SubmitButton>
                </form>
              </div>
            </details>
          </div>
        </details>
      </div>

      {/* Timeline */}
      <div className="card">
        <h2 className="section-label">Timeline</h2>
        <Timeline meta={meta!} />
      </div>

      {/* Documents */}
      <div className="doc-grid">
        <div className="card doc-card">
          <div className="doc-head">
            <div style={{ fontWeight: 650 }}>Résumé</div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              {hasResume && genReport
                ? `Tailored, ATS-safe .docx · coverage ${(genReport.atsCoverage * 100).toFixed(0)}% · ${genReport.provenanceEntries} claims traced`
                : "Not generated yet · tailored from verified facts only"}
            </div>
          </div>
          <div className="doc-actions">
            {hasResume && (
              <a className="button-link" href={`/api/download?app=${encodeURIComponent(meta!.id)}&file=resume.docx`}>
                ↓ .docx
              </a>
            )}
            {report && (
              <form action={generateResumeAction}>
                <input type="hidden" name="appId" value={meta!.id} />
                <SubmitButton secondary={hasResume} pendingLabel="Writing… a few minutes">
                  {hasResume ? "Regenerate" : "Generate"}
                </SubmitButton>
              </form>
            )}
          </div>
        </div>
        <div className="card doc-card">
          <div className="doc-head">
            <div style={{ fontWeight: 650 }}>Cover letter</div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              {hasLetter
                ? "Drafted in your voice · plain prose, no AI tells"
                : "Optional · only some applications want one"}
            </div>
          </div>
          <div className="doc-actions">
            {hasLetter && (
              <a className="button-link" href={`/api/download?app=${encodeURIComponent(meta!.id)}&file=cover-letter.docx`}>
                ↓ .docx
              </a>
            )}
            <form action={generateCoverLetterAction}>
              <input type="hidden" name="appId" value={meta!.id} />
              <SubmitButton secondary={hasLetter} pendingLabel="Writing… about a minute">
                {hasLetter ? "Regenerate" : "Generate"}
              </SubmitButton>
            </form>
          </div>
        </div>
      </div>

      {/* Score comparison (hero when a rescore exists) */}
      {versions.length >= 2 && <ScoreCompare versions={versions} />}

      {/* Full assessment */}
      {report ? (
        <details className="assessment" open={versions.length < 2}>
          <summary className="section-label">Full assessment (three axes)</summary>
          <Scorecard report={report} />
        </details>
      ) : (
        <div className="card">
          <p className="muted">No score yet. Scoring may have failed at capture time.</p>
        </div>
      )}

      {/* Application form — what the live form will ask (harvested at capture) */}
      {form && (() => {
        const drafted = new Set((questions ?? []).map((q) => q.question.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()));
        const writing = form.questions.filter(isWritingQuestion);
        return (
          <div className="card">
            <h2 className="section-label">Application form</h2>
            {writing.length === 0 ? (
              <p className="muted">No written questions beyond the standard fields.</p>
            ) : (
              writing.map((q) => {
                const done = drafted.has(q.label.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim());
                return (
                  <p key={q.label} style={{ margin: "0.3rem 0" }}>
                    {done ? "✓" : "○"} {q.label}
                    {q.required && <span className="muted"> *</span>}
                    {q.kind === "essay" && <span className="badge" style={{ marginLeft: "0.4rem" }}>essay</span>}
                    {!done && <span className="muted"> — no draft yet</span>}
                  </p>
                );
              })
            )}
          </div>
        );
      })()}

      {/* Application questions (drafted + approved in the conversation) */}
      {(questions?.length ?? 0) > 0 && (
        <div className="card">
          <h2 className="section-label">Application questions</h2>
          {questions!.map((q, i) => (
            <div key={i} className="gap-item">
              <div style={{ fontWeight: 650 }}>{q.question}</div>
              <p className="muted" style={{ margin: "0.3rem 0 0", whiteSpace: "pre-wrap" }}>
                {q.answer}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Stage-aware conversation / actions */}
      {stage === "draft" && report && (
        <>
          <div className="section-head">
            <h2>Go deeper on this job</h2>
          </div>
          <TailorChat appId={meta!.id} initialMessages={conversation?.messages ?? []} mode="tailor" />
        </>
      )}

      {stage === "ongoing" && (
        <>
          <div className="section-head">
            <h2>Interview prep</h2>
          </div>
          <TailorChat appId={meta!.id} initialMessages={prepConversation?.messages ?? []} mode="prep" />
        </>
      )}

      {/* Job ad snapshot */}
      <details className="card">
        <summary className="section-label" style={{ cursor: "pointer" }}>
          Job ad snapshot
        </summary>
        <pre className="snapshot">{snapshot ?? "—"}</pre>
      </details>
    </main>
  );
}

const TIMELINE_TONE: Record<string, string> = {
  offer: "var(--accent)",
  interviewing: "var(--warn)",
  applied: "var(--accent)",
  rejected: "var(--danger)",
};

function Timeline({ meta }: { meta: ApplicationMeta }) {
  const history = meta.status_history ?? [{ status: meta.status, at: meta.captured_at }];
  return (
    <ol className="timeline">
      {history.map((h, i) => {
        const isLast = i === history.length - 1;
        return (
          <li key={i}>
            <span
              className="timeline-dot"
              style={{ background: isLast ? (TIMELINE_TONE[h.status] ?? "var(--muted)") : "var(--muted)" }}
            />
            <div className="row-between">
              <span style={{ fontWeight: isLast ? 650 : 400, fontSize: "0.9rem" }}>
                {STATUS_META[h.status]?.label ?? h.status}
              </span>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {h.at.slice(0, 10)}
              </span>
            </div>
            {h.note && (
              <p className="muted" style={{ margin: "0.1rem 0 0", fontSize: "0.78rem" }}>
                {h.note}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
