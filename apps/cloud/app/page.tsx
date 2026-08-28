import Link from "next/link";
import { auth } from "../auth";
import { archiveAction, signInAction, signOutAction } from "./actions";
import SubmitButton from "../components/SubmitButton";
import { getSessionContext, isContextError } from "../lib/session";
import { getSetupStatus, type SetupStatus } from "../lib/setup-status";
import { loadIndexHealed, STATUS_META, type IndexEntry } from "@kairos/engine/applications";
import Board, { type SourcedCard } from "../components/Board";
import type { HealthReport } from "@kairos/engine/health";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { archived: showArchived } = await searchParams;
  const session = await auth();

  if (!session?.user) return <Landing />;

  const ctx = await getSessionContext();
  // A stale session (expired/revoked Google refresh token) looks signed-in but
  // can't reach Drive. Force a clean re-login instead of a half-broken page.
  if (
    isContextError(ctx) &&
    ["RefreshAccessTokenError", "NoRefreshToken", "no_drive_token"].includes(ctx.error)
  ) {
    return (
      <main>
        <div className="hero">
          <h1>Your session expired</h1>
          <p className="lede">
            Google needs you to sign in again — this happens when a login gets too old or was
            granted on another device. Nothing is lost: your data lives in your Drive and will
            be right here after you sign back in.
          </p>
          <form action={signOutAction}>
            <SubmitButton pendingLabel="Signing out…">Sign out & sign in again</SubmitButton>
          </form>
        </div>
      </main>
    );
  }
  if (isContextError(ctx) && ctx.error === "drive_not_granted") {
    return (
      <main>
        <div className="hero">
          <h1>One checkbox missing</h1>
          <p className="lede">
            You signed in, but Google Drive access wasn't granted, and Kairos stores everything
            in your own Drive, so it can't work without it. Sign out, sign in again, and keep
            the box about seeing and creating "files you open or create with this app" checked.
            That permission only covers files Kairos itself creates, never your other Drive
            files.
          </p>
          <form action={signOutAction}>
            <SubmitButton pendingLabel="Signing out…">Sign out & try again</SubmitButton>
          </form>
        </div>
      </main>
    );
  }
  let status: SetupStatus = { driveReady: false, keyMasked: null, template: null, kbRoles: 0, ready: false };
  let allApps: IndexEntry[] = [];
  let sourcedRun: { ran_at: string; survivors: SourcedCard[]; stretch: SourcedCard[] } | null = null;
  let health: HealthReport | null = null;
  if (!isContextError(ctx)) {
    status = await getSetupStatus(ctx.store);
    if (status.kbRoles > 0) {
      [allApps, health, sourcedRun] = await Promise.all([
        loadIndexHealed(ctx.store).then((i) =>
          [...i.applications].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        ),
        ctx.store.readJson<HealthReport>(["knowledge-base", "_health.json"]),
        ctx.store.readJson<{ ran_at: string; survivors: SourcedCard[]; stretch: SourcedCard[] }>([
          "sourcing",
          "last-run.json",
        ]),
      ]);
    }
  }
  const apps = allApps.filter((a) => !a.archived);
  const archivedApps = allApps.filter((a) => a.archived);

  return (
    <main className="wide">
      <div className="tiles">
        <Tile
          done={status.driveReady}
          label="Drive"
          detail={status.driveReady ? "Connected" : "Not connected"}
          href="/settings"
        />
        <Tile
          done={status.keyMasked !== null}
          label="API key"
          detail={status.keyMasked ?? "None yet"}
          href="/settings"
        />
        <Tile
          done={status.kbRoles > 0}
          label="Knowledge base"
          detail={
            status.kbRoles > 0
              ? `${status.kbRoles} roles${health ? ` · health ${health.overall}/100` : ""}`
              : status.ready
                ? "Upload your résumé"
                : "After Drive & key"
          }
          href={status.kbRoles > 0 ? "/kb" : status.ready ? "/onboard" : "/settings"}
        />
      </div>

      {status.kbRoles === 0 ? (
        <div className="card">
          <h2>Get set up</h2>
          <p className="muted">
            Three steps: connect your Drive, add your Anthropic API key, then upload your résumé.
            Everything Kairos produces lives in your own Drive.
          </p>
          <Link href={status.ready ? "/onboard" : "/settings"}>
            {status.ready ? "Upload your résumé →" : "Start in settings →"}
          </Link>
        </div>
      ) : (
        <>
          <div className="row-between section-head">
            <h2>Applications</h2>
            <Link href="/applications/new" className="button-link">
              + New application
            </Link>
          </div>
          {apps.length === 0 ? (
            <div className="card">
              <p className="muted">
                No applications yet. Paste a job ad and Kairos scores you against it honestly,
                before any résumé gets written.
              </p>
              <Link href="/applications/new">Score your first job ad →</Link>
            </div>
          ) : (
            <Board
              apps={apps}
              sourced={sourcedRun ? [...sourcedRun.survivors, ...sourcedRun.stretch] : []}
              sourcedRanAt={sourcedRun?.ran_at}
            />
          )}

          {archivedApps.length > 0 &&
            (showArchived ? (
              <div className="card" style={{ marginTop: "1.5rem" }}>
                <div className="row-between">
                  <h2 className="section-label">Archived ({archivedApps.length})</h2>
                  <Link href="/" className="muted">
                    Hide
                  </Link>
                </div>
                {archivedApps.map((a) => (
                  <div key={a.id} className="row-between archived-row">
                    <span>
                      <Link href={`/applications/${encodeURIComponent(a.id)}`}>{a.company}</Link>{" "}
                      <span className="muted">· {a.role}</span>{" "}
                      <span className={`badge tone-${STATUS_META[a.status].tone}`}>{STATUS_META[a.status].label}</span>
                    </span>
                    <form action={archiveAction}>
                      <input type="hidden" name="appId" value={a.id} />
                      <input type="hidden" name="archived" value="0" />
                      <button className="linklike">Restore</button>
                    </form>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ marginTop: "0.8rem" }}>
                <Link href="/?archived=1" className="muted">
                  Show archived ({archivedApps.length})
                </Link>
              </p>
            ))}

          {health && health.topFixes.length > 0 && (
            <div className="card" style={{ marginTop: "1.5rem" }}>
              <h2>Strengthen your knowledge base</h2>
              <ol className="muted fixes">
                {health.topFixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ol>
              <Link href="/kb">Full health report →</Link>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function Tile({ done, label, detail, href }: { done: boolean; label: string; detail: string; href: string }) {
  return (
    <Link href={href} className={`tile ${done ? "done" : ""}`}>
      <span className={`status ${done ? "done" : ""}`}>{done ? "✓" : "·"}</span>
      <span>
        <span className="tile-label">{label}</span>
        <span className="tile-detail muted">{detail}</span>
      </span>
    </Link>
  );
}

function Landing() {
  return (
    <main>
      <div className="hero">
        <h1>Résumés that fit the job, built from what you've actually done.</h1>
        <p className="lede">
          Kairos is a tool for students and job seekers. Paste a job ad and it tailors your
          résumé to fit, honestly: nothing invented, nothing generic. Just your real experience,
          told right.
        </p>
        <p className="lede">
          Kairos itself is free. What you'll need: a Google account (your files stay in your
          Drive; Kairos can only see the files it creates) and an Anthropic API key from
          console.anthropic.com (you pay Anthropic directly for what you use, typically cents per
          application).
        </p>
        <form action={signInAction}>
          <SubmitButton pendingLabel="Heading to Google…">Sign in with Google</SubmitButton>
        </form>
        <p className="muted" style={{ marginTop: "0.8rem" }}>
          Your data never touches our servers.
        </p>
      </div>

      <div className="grid-3">
        <div className="card">
          <h2>Your experience, captured once</h2>
          <p>
            Upload your résumé and Kairos builds a knowledge base of what you've really done. It
            interviews you to fill the gaps, and it gets better with every application.
          </p>
        </div>
        <div className="card">
          <h2>Tailored to each job ad</h2>
          <p>
            Every job gets an honest fit score, the gaps named plainly, and a résumé that speaks
            the ad's language where you truly match.
          </p>
        </div>
        <div className="card">
          <h2>We never hold your data</h2>
          <p>
            Everything lives in your Google Drive. Claude runs on your own API key. There's no
            database on our side to leak, sell, or lose.
          </p>
        </div>
      </div>

      <div className="contact-strip">
        <p className="muted">
          Questions about how Kairos works, what it stores, or how to get set up? Ask. A real
          person answers.
        </p>
        <a className="button-link" href="mailto:hello@example.com?subject=Kairos">
          Contact
        </a>
      </div>
    </main>
  );
}
