"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../lib/models";
import { streamTurn } from "../lib/stream-client";

interface Msg {
  role: "user" | "assistant";
  content: string;
  saved?: { section: string; content: string }[];
}

/**
 * The enrichment interview panel. The transcript lives HERE (DEC-5: the server
 * keeps no conversation state); every turn posts the whole history and gets
 * back the reply, any [C] facts saved to Drive, and the refreshed health score.
 */
export default function EnrichChat({
  fileName,
  roleLabel,
  initialHealth,
}: {
  fileName: string;
  roleLabel: string;
  initialHealth: number | null;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<number | null>(initialHealth);
  const [savedCount, setSavedCount] = useState(0);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const modelRef = useRef(model);
  const started = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore the student's last model choice (their key, their tradeoff).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("kairos-model");
      if (saved && MODEL_OPTIONS.some((m) => m.id === saved)) {
        setModel(saved);
        modelRef.current = saved;
      }
    } catch {}
  }, []);

  function pickModel(id: string) {
    setModel(id);
    modelRef.current = id;
    try {
      localStorage.setItem("kairos-model", id);
    } catch {}
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

  const [draft, setDraft] = useState("");

  async function turn(history: Msg[]) {
    setPending(true);
    setError(null);
    setDraft("");
    try {
      const data = await streamTurn<{
        reply?: string;
        saved?: { section: string; content: string }[];
        healthOverall?: number | null;
      }>(
        "/api/enrich",
        {
          fileName,
          messages: history.map(({ role, content }) => ({ role, content })),
          model: modelRef.current,
        },
        { onDelta: (t) => setDraft((d) => d + t) },
      );
      if (!data.reply) {
        setError("Empty reply. Send that again.");
        return;
      }
      setMessages([...history, { role: "assistant", content: data.reply, saved: data.saved }]);
      if (data.saved?.length) setSavedCount((n) => n + data.saved!.length);
      if (typeof data.healthOverall === "number") setHealth(data.healthOverall);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network hiccup. Send that again.");
    } finally {
      setPending(false);
      setDraft("");
    }
  }

  // Kick off: Claude greets and asks the first question.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void turn([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    const history: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
    void turn(history);
  }

  return (
    <div className="card chat-card">
      <div className="chat-meta">
        <span className="muted">{roleLabel}</span>
        <span className="chat-stats">
          {savedCount > 0 && (
            <span className="badge ok">
              {savedCount} fact{savedCount === 1 ? "" : "s"} saved
            </span>
          )}
          {health !== null && <span className="badge">health {health}/100</span>}
          <select
            className="model-pick"
            value={model}
            onChange={(e) => pickModel(e.target.value)}
            aria-label="Interview model"
            title={MODEL_OPTIONS.find((m) => m.id === model)?.blurb}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id} title={m.blurb}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="model-blurb muted">{MODEL_OPTIONS.find((m) => m.id === model)?.blurb}</div>

      <div className="chat-log">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.content}</div>
            {m.saved?.map((s, j) => (
              <div key={j} className="saved-chip">
                ✓ saved to {s.section} [C]
              </div>
            ))}
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            {draft ? (
              <div className="bubble">{draft}</div>
            ) : (
              <div className="bubble muted">
                <span className="spinner" aria-hidden />
                {messages.length === 0 ? "Reading this role…" : "Thinking…"}
              </div>
            )}
          </div>
        )}
        {error && <div className="card flash-err">⚠ {error}</div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="chat-input">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={pending ? "…" : "Type your answer"}
          disabled={pending}
        />
        <button type="submit" disabled={pending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
