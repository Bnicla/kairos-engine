"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../lib/models";
import { streamTurn } from "../lib/stream-client";

interface Msg {
  role: "user" | "assistant";
  content: string;
  saved?: { fileName: string; section: string; content: string }[];
  rescored?: { band: string; recommendation: string } | null;
  answersSaved?: string[];
  letterDrafted?: boolean;
}

const MODES = {
  tailor: {
    endpoint: "/api/tailor",
    meta: "Close the gaps, sharpen the framing",
    startLabel: "Start the tailoring conversation",
    startHint:
      "Kairos walks the score's gaps one question at a time, saves what you confirm into your knowledge base, and can rescore. Nothing runs until you start.",
    firstPending: "Reading your score & knowledge base…",
  },
  prep: {
    endpoint: "/api/interview",
    meta: "Interview prep",
    startLabel: "Start interview prep",
    startHint:
      "Company research on your key, your strongest stories mapped to this ad, the interviewer's real tests decoded, then rehearsal. Nothing runs until you start.",
    firstPending: "Reading the ad, your score & knowledge base…",
  },
} as const;

/**
 * The application conversation panel (tailoring or interview prep). Start-gated:
 * no turn runs, and no tokens are spent, until the student clicks start — an
 * existing transcript renders immediately and resumes where it stopped.
 */
export default function TailorChat({
  appId,
  initialMessages,
  mode = "tailor",
}: {
  appId: string;
  initialMessages: Msg[];
  mode?: keyof typeof MODES;
}) {
  const cfg = MODES[mode];
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [started, setStarted] = useState(initialMessages.length > 0);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const modelRef = useRef(model);
  const endRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [statusLine, setStatusLine] = useState<string | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, pending]);

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

  async function turn(history: Msg[]) {
    setPending(true);
    setError(null);
    setDraft("");
    setStatusLine(null);
    try {
      const data = await streamTurn<{
        reply?: string;
        saved?: Msg["saved"];
        rescored?: Msg["rescored"];
        answersSaved?: string[];
        letterDrafted?: boolean;
      }>(
        cfg.endpoint,
        {
          appId,
          messages: history.map(({ role, content }) => ({ role, content })),
          model: modelRef.current,
        },
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
      setMessages([
        ...history,
        {
          role: "assistant",
          content: data.reply,
          saved: data.saved,
          rescored: data.rescored,
          answersSaved: data.answersSaved,
          letterDrafted: data.letterDrafted,
        },
      ]);
      // Band chips, doc cards, and the questions section above may have changed.
      if (data.rescored || data.letterDrafted || (data.answersSaved?.length ?? 0) > 0) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network hiccup. Send that again.");
    } finally {
      setPending(false);
      setDraft("");
      setStatusLine(null);
    }
  }

  function start() {
    setStarted(true);
    void turn([]);
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

  if (!started) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: "0 0 0.8rem" }}>{cfg.startHint}</p>
        <button type="button" onClick={start}>
          {cfg.startLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="card chat-card">
      <div className="chat-meta">
        <span className="muted">{cfg.meta}</span>
        <span className="chat-stats">
          <select
            className="model-pick"
            value={model}
            onChange={(e) => pickModel(e.target.value)}
            aria-label="Conversation model"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id} title={m.blurb}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="chat-log">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.content}</div>
            {m.saved?.map((s, j) => (
              <div key={j} className="saved-chip">
                ✓ saved to {s.fileName.replace(/^\d+-|\.md$/g, "")} · {s.section} [C]
              </div>
            ))}
            {m.rescored && (
              <div className="saved-chip">
                ↻ rescored: {m.rescored.band} · {m.rescored.recommendation.replaceAll("_", " ")}
              </div>
            )}
            {m.answersSaved?.map((q, j) => (
              <div key={`a${j}`} className="saved-chip">
                ✓ answer banked: {q.length > 60 ? `${q.slice(0, 60)}…` : q}
              </div>
            ))}
            {m.letterDrafted && <div className="saved-chip">✓ cover letter drafted (documents above)</div>}
          </div>
        ))}
        {pending && (
          <div className="msg assistant">
            {draft ? (
              <div className="bubble">{draft}</div>
            ) : (
              <div className="bubble muted">
                <span className="spinner" aria-hidden />
                {statusLine ?? (messages.length === 0 ? cfg.firstPending : "Thinking…")}
              </div>
            )}
            {draft && statusLine && (
              <div className="saved-chip">
                <span className="spinner" aria-hidden /> {statusLine}
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
