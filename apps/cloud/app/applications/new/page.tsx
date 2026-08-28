import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../../lib/session";
import { getSetupStatus } from "../../../lib/setup-status";
import CaptureChat from "../../../components/CaptureChat";

export const dynamic = "force-dynamic";

export default async function NewApplication({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url: prefillUrl } = await searchParams;
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const status = await getSetupStatus(ctx.store);

  if (!status.ready || status.kbRoles === 0) {
    return (
      <main>
        <div className="hero">
          <h1>New application</h1>
        </div>
        <div className="card">
          <p className="muted">
            Applications score you against your knowledge base, so finish setup first:
            {!status.ready ? " connect Drive and add your API key in settings, then " : " "}
            upload your résumé to build the knowledge base.
          </p>
          <p>
            {!status.ready ? (
              <Link href="/settings">Go to settings →</Link>
            ) : (
              <Link href="/onboard">Build your knowledge base →</Link>
            )}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="hero">
        <h1>New application</h1>
        <p className="lede">
          Share the job ad however you have it: a link, a saved file, or pasted text. Kairos
          snapshots it (ads change and vanish), then scores you against it honestly. Scoring runs
          on Claude Opus with your key (roughly 10–20¢).
        </p>
      </div>

      <CaptureChat initialInput={prefillUrl ?? ""} />

      <p className="footnote">
        <Link href="/">← Back to the board</Link>
      </p>
    </main>
  );
}
