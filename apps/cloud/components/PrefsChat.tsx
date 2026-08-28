"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../lib/models";
import { streamTurn } from "../lib/stream-client";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/**
 * Sourcing-preferences conversation. Same stateless pattern as EnrichChat:
 * the transcript lives here; each turn posts the whole history and the server
 * saves confirmed preferences to the user's Drive.
 */
export default function PrefsChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileDesc, setProfileDesc] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const modelRef = useRef(model);
  const started = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("kairos-model");
      if (saved && MODEL_OPTIONS.some((m) => m.id === saved)) {
        setModel(saved);
        modelRef.current = saved;
      }
    } catch {}
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

  async function turn(history: Msg[]) {
    setPending(true);
    setError(null);
    setDraft("");
    try {
      const data = await streamTurn<{ reply?: string; profileDescription?: string | null }>(
        "/api/sourcing-prefs",
        {
          messages: history.map(({ role, content }) => ({ role, content })),
          model: modelRef.current,
        },
        { onDelta: (t) => setDraft((d) => d + t) },
      );
      if (!data.reply) {
        setError("Empty reply. Send that again.");
        return;
      }
      setMessages([...history, { role: "assistant", content: data.reply }]);
      if (data.profileDescription) setProfileDesc(data.profileDescription);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network hiccup. Send that again.");
    } finally {
      setPending(false);
      setDraft("");
    }
  }

  function start() {
    setOpen(true);
    if (!started.current) {
      started.current = true;
      void turn([]);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    const history: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
    void turn(history);
  }

  if (!open) {
    return (
      <button className="button-link" onClick={start}>
        Set up sourcing preferences →
      </button>
    );
  }

  return (
    <div className="chat-card" style={{ marginTop: "0.8rem" }}>
      {profileDesc && (
        <div className="muted" style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", marginBottom: "0.6rem" }}>
          {profileDesc}
        </div>
      )}
      <div className="chat-log">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            {draft ? (
              <div className="bubble">{draft}</div>
            ) : (
              <div className="bubble muted">
                <span className="spinner" aria-hidden />
                {messages.length === 0 ? "Reading your preferences…" : "Thinking…"}
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
          placeholder={pending ? "…" : "e.g. Chicago or remote, senior product roles, AI companies"}
          disabled={pending}
        />
        <button type="submit" disabled={pending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
