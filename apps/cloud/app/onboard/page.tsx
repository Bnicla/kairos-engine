import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../lib/session";
import { getSetupStatus } from "../../lib/setup-status";
import { onboardResumeAction } from "../actions";
import SubmitButton from "../../components/SubmitButton";

export const dynamic = "force-dynamic";
// Extraction is one long Claude call; give the server action room on Vercel.
export const maxDuration = 300;

export default async function Onboard({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const status = await getSetupStatus(ctx.store);

  return (
    <main>
      <div className="hero">
        <h1>Build your knowledge base</h1>
        <p className="lede">
          Upload your résumé. Kairos reads it with Claude and turns every real fact into a
          structured knowledge base in your Drive, then grades it honestly so you know exactly
          what to improve.
        </p>
      </div>

      {e && <div className="card flash-err">⚠ {e}</div>}

      {!status.ready ? (
        <div className="card">
          <h2>Two things first</h2>
          <p className="muted">
            Onboarding needs your Drive connected and your Anthropic API key on file. The
            extraction runs on your key, in your Drive.
          </p>
          <p>
            <Link href="/settings">Finish setup in settings →</Link>
          </p>
        </div>
      ) : (
        <div className="card">
          <form action={onboardResumeAction}>
            <input type="file" name="resume" accept=".pdf,.docx,.txt,.md" />
            <SubmitButton pendingLabel="Reading your résumé and building your knowledge base… about a minute">
              Build my knowledge base
            </SubmitButton>
          </form>
          <p className="muted" style={{ marginTop: "0.8rem" }}>
            PDF, DOCX, or plain text. Nothing is invented: every extracted fact is tagged as
            coming from your résumé, and the file lands in your own Drive. Re-uploading later
            replaces the extraction.
          </p>
        </div>
      )}

      <div className="grid-3">
        <div className="card">
          <h2>1 · Extract</h2>
          <p>Each role becomes a structured file: title, dates, scope, skills, achievements. Only what your résumé actually says.</p>
        </div>
        <div className="card">
          <h2>2 · Health check</h2>
          <p>A deterministic report scores the résumé on impact, metrics, voice, and depth, with the exact bullets to fix.</p>
        </div>
        <div className="card">
          <h2>3 · Enrich</h2>
          <p>Kairos then interviews you to capture what the résumé left out: real stories and numbers, marked as confirmed by you.</p>
        </div>
      </div>

      <p className="footnote">
        <Link href="/">← Back home</Link>
      </p>
    </main>
  );
}
