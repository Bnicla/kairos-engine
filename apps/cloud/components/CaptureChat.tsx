"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamTurn } from "../lib/stream-client";

interface Msg {
  role: "user" | "assistant";
  content: string;
  /** Compact label shown instead of the raw content (e.g. uploaded-file text). */
  display?: string;
}

type Source = "link" | "upload" | "paste";

/**
 * Conversational application capture with three entry paths: link, file
 * upload, or pasted text. Every path lands in the same conversation, and every
 * failure (blocked link, wrong file, wrong text) is recoverable in-chat by
 * switching to another source, including a mid-chat upload button.
 */
export default function CaptureChat({ initialInput = "" }: { initialInput?: string }) {
  const router = useRouter();
  const [source, setSource] = useState<Source | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState(initialInput);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

  useEffect(() => {
    if (!appId) return;
    const t = setTimeout(() => router.push(`/applications/${encodeURIComponent(appId)}`), 2500);
    return () => clearTimeout(t);
  }, [appId, router]);

  async function turn(history: Msg[]) {
    setPending(true);
    setError(null);
    setDraft("");
    setStatusLine(null);
    try {
      const data = await streamTurn<{ reply?: string; appId?: string | null }>(
        "/api/capture",
        { messages: history.map(({ role, content }) => ({ role, content })) },
        {
          onDelta: (t) => {
            setDraft((d) => d + t);
            setStatusLine(null);
          },
          onStatus: (t) => setStatusLine(t),
        },
      );
      if (!data.reply) {
        setError("Empty reply. Send that again.");
        return;
      }
      setMessages([...history, { role: "assistant", content: data.reply }]);
      if (data.appId) setAppId(data.appId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network hiccup. Send that again.");
    } finally {
      setPending(false);
      setDraft("");
      setStatusLine(null);
    }
  }

  function sendText(text: string, display?: string) {
    const history: Msg[] = [...messages, { role: "user", content: text, display }];
    setMessages(history);
    void turn(history);
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    sendText(text);
  }

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/extract-ad", { method: "POST", body: form });
      const data = (await res.json()) as { name?: string; text?: string; error?: string };
      if (!res.ok || !data.text) {
        setError(data.error ?? "Couldn't read that file.");
        return;
      }
      sendText(`UPLOADED AD FILE "${data.name}":\n\n${data.text}`, `📄 ${data.name}`);
    } catch {
      setError("Upload failed. Try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const started = messages.length > 0;

  // Source chooser: three doors into the same conversation.
  if (!started && source === null) {
    return (
      <div className="grid-3">
        <button type="button" className="card source-card" onClick={() => setSource("link")}>
          <h2>Link</h2>
          <p className="muted">Paste the job ad's URL. Kairos reads the page itself.</p>
        </button>
        <button type="button" className="card source-card" onClick={() => fileRef.current?.click()}>
          <h2>Upload</h2>
          <p className="muted">A PDF, DOCX, or text file of the ad, saved from the job board.</p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            hidden
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          {uploading && (
            <p className="muted">
              <span className="spinner" aria-hidden /> Reading the file…
            </p>
          )}
        </button>
        <button type="button" className="card source-card" onClick={() => setSource("paste")}>
          <h2>Paste</h2>
          <p className="muted">Copy the ad's text and paste it straight in.</p>
        </button>
        {error && <div className="card flash-err" style={{ gridColumn: "1 / -1" }}>⚠ {error}</div>}
      </div>
    );
  }

  return (
    <div className="card chat-card">
      <div className="chat-log">
        {!started && (
          <p className="muted" style={{ margin: 0 }}>
            {source === "link"
              ? "Paste the job ad's URL below. If the site blocks me, we'll fall back to a file or pasted text."
              : "Paste the full ad text below. If it doesn't look right, we can switch to a link or a file."}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.display ?? m.content}</div>
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            {draft ? (
              <div className="bubble">{draft}</div>
            ) : (
              <div className="bubble muted">
                <span className="spinner" aria-hidden />
                {statusLine ?? "Reading the ad…"}
              </div>
            )}
            {draft && statusLine && (
              <div className="saved-chip">
                <span className="spinner" aria-hidden /> {statusLine}
              </div>
            )}
          </div>
        )}
        {appId && (
          <div className="card flash-ok" style={{ margin: 0 }}>
            ✓ Application created. Taking you to the scorecard…{" "}
            <a href={`/applications/${encodeURIComponent(appId)}`}>open now →</a>
          </div>
        )}
        {error && <div className="card flash-err">⚠ {error}</div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="chat-input">
        <button
          type="button"
          className="secondary attach"
          title="Upload the ad as a file"
          disabled={pending || uploading || appId !== null}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <span className="spinner" aria-hidden /> : "📎"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          hidden
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <textarea
          rows={started ? 3 : source === "paste" ? 6 : 1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            pending
              ? "…"
              : started
                ? "Answer, paste the ad text, or attach a file"
                : source === "link"
                  ? "https://… the job ad URL"
                  : "Paste the full job ad text here"
          }
          disabled={pending || appId !== null}
        />
        <button type="submit" disabled={pending || appId !== null || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
