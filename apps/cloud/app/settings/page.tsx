import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext, isContextError } from "../../lib/session";
import { getSetupStatus } from "../../lib/setup-status";
import { importArchiveAction, initDriveAction, saveKeyAction, signOutAction, uploadTemplateAction } from "../actions";
import SubmitButton from "../../components/SubmitButton";
import PrefsChat from "../../components/PrefsChat";

export const dynamic = "force-dynamic";
// The data import writes a whole Kairos tree to Drive, file by file.
export const maxDuration = 300;

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; e?: string }>;
}) {
  const { ok, e } = await searchParams;
  const ctx = await getSessionContext();
  if (isContextError(ctx)) redirect("/");
  const status = await getSetupStatus(ctx.store);

  return (
    <main>
      <div className="hero">
        <h1>Settings</h1>
        <p className="lede">Everything here is stored in your own Google Drive.</p>
      </div>

      {ok && <div className="card flash-ok">✓ {ok}</div>}
      {e && <div className="card flash-err">⚠ {e}</div>}

      <div className="card step">
        <div className={`status ${status.driveReady ? "done" : ""}`}>{status.driveReady ? "✓" : "1"}</div>
        <div className="body">
          <h2>
            Your Drive{" "}
            <span className={`badge ${status.driveReady ? "ok" : "todo"}`}>
              {status.driveReady ? "connected" : "not set up"}
            </span>
          </h2>
          <p className="muted">
            {status.driveReady
              ? "The Kairos/ folder exists in your Drive. Deleting that folder deletes everything Kairos knows."
              : "Creates a Kairos/ folder tree in your Google Drive. Everything the app produces lives there, owned by you."}
          </p>
          <form action={initDriveAction}>
            <SubmitButton secondary={status.driveReady} pendingLabel="Talking to Drive…">
              {status.driveReady ? "Re-check" : "Set up my Drive"}
            </SubmitButton>
          </form>
        </div>
      </div>

      <div className="card step">
        <div className={`status ${status.keyMasked ? "done" : ""}`}>{status.keyMasked ? "✓" : "2"}</div>
        <div className="body">
          <h2>
            Anthropic API key{" "}
            <span className={`badge ${status.keyMasked ? "ok" : "todo"}`}>
              {status.keyMasked ? `on file · ${status.keyMasked}` : "none yet"}
            </span>{" "}
            <details className="help">
              <summary title="How do I get a key?">?</summary>
              <div className="pop">
                <strong>How to get your key</strong>
                <ol>
                  <li>
                    Sign up at{" "}
                    <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
                      console.anthropic.com
                    </a>{" "}
                    (separate from claude.ai, same email is fine).
                  </li>
                  <li>Billing → add credits ($5 minimum goes a long way; Kairos uses cents per application).</li>
                  <li>
                    API keys → Create key. It starts with <code>sk-ant-</code> and is shown once. 
                    copy it right away and paste it below.
                  </li>
                </ol>
              </div>
            </details>
          </h2>
          <p className="muted">
            It's encrypted (AES-256) and stored in your Drive; Kairos decrypts it only in memory,
            per request, to call Claude on your behalf.
          </p>
          <form action={saveKeyAction}>
            <input type="password" name="anthropic_key" placeholder="sk-ant-…" autoComplete="off" />
            <SubmitButton pendingLabel="Encrypting into your Drive…">
              {status.keyMasked ? "Replace key" : "Save key"}
            </SubmitButton>
          </form>
        </div>
      </div>

      <div className="card step">
        <div className={`status ${status.template ? "done" : ""}`}>{status.template ? "✓" : "3"}</div>
        <div className="body">
          <h2>
            Résumé template <span className="badge">optional</span>
          </h2>
          <p className="muted">
            {status.template
              ? `Using the design from ${status.template.source}${status.template.detected.length ? ` (detected: ${status.template.detected.join(", ")})` : " (no overrides detected; default design in use)"}.`
              : "Upload a .docx whose DESIGN you like: font, sizes, margins, colors. Kairos copies the design only; content always comes from your knowledge base. Skip this to use the clean default."}
          </p>
          <form action={uploadTemplateAction}>
            <input type="file" name="template" accept=".docx" />
            <SubmitButton secondary={!!status.template} pendingLabel="Uploading & reading the design…">
              {status.template ? "Replace template" : "Upload template"}
            </SubmitButton>
          </form>
        </div>
      </div>

      <div className="card step">
        <div className="status">⌁</div>
        <div className="body">
          <h2>Sourcing preferences</h2>
          <p className="muted">
            What the job sweep looks for: your locations (including remote), the discipline and
            seniority words that count, topics that boost a job, and how fresh a posting must be.
            Set it up in a short conversation — Kairos starts from your profile and adjusts to what
            you say. Runs on your API key.
          </p>
          <PrefsChat />
        </div>
      </div>

      <div className="card step">
        <div className="status">⇪</div>
        <div className="body">
          <h2>
            Import your data <span className="badge">advanced</span>
          </h2>
          <p className="muted">
            Upload a zip of a Kairos folder (for example the local lane's <code>~/Kairos</code>) and it becomes
            your cloud data: applications, knowledge base and answer bank here are replaced by
            what's in the archive. Your API key and template are kept.
          </p>
          <form action={importArchiveAction}>
            <input type="file" name="archive" accept=".zip" />
            <SubmitButton pendingLabel="Writing everything into your Drive…">Import archive</SubmitButton>
          </form>
        </div>
      </div>

      <div className="card row-between">
        <span className="muted">Signed in as {ctx.email}</span>
        <form action={signOutAction}>
          <SubmitButton secondary pendingLabel="Signing out…">
            Sign out
          </SubmitButton>
        </form>
      </div>

      <p className="footnote">
        <Link href="/">← Back home</Link>
      </p>
    </main>
  );
}
