"use client";

import { useEffect, useRef, useState } from "react";

type Role = "user" | "assistant" | "tool";

interface ToolCall {
  name: string;
  args: unknown;
  raw: string;
}

interface ToolCallState {
  call: ToolCall;
  status: "running" | "done" | "error";
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  tool_name?: string;
  tool_error?: string;
  tool_calls?: ToolCall[];
  // client-side only
  streaming?: boolean;
  toolCalls?: ToolCallState[];
}

let msgCounter = 0;
const nextId = () => `m-${++msgCounter}-${Date.now()}`;

/** How often we ask the server "any new tokens yet?" */
const POLL_INTERVAL_MS = 500;

/** Hard ceiling on a single turn. Generous — DeepThink can run minutes. */
const POLL_DEADLINE_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // One chat session per browser. Persist to localStorage so a reload
  // keeps the same thread on the server side too.
  useEffect(() => {
    const existing = localStorage.getItem("openhub_chat_session");
    if (existing) {
      setSessionId(existing);
    } else {
      const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("openhub_chat_session", id);
      setSessionId(id);
    }
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || busy) return;

    setError(null);
    setBusy(true);
    setInput("");

    const userMsg: Message = { id: nextId(), role: "user", content: text };
    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `request failed: ${res.status}`);
      }
      const { chat_id } = (await res.json()) as { chat_id: string };

      await pollUntilDone(chat_id, assistantId);
    } catch (e) {
      setError((e as Error).message);
      markDone(assistantId);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Poll the server for the accumulated reply text. Each poll is a
   * short-lived function call — the daemon holds the browser, Vercel holds
   * the buffer, we just read it. No long-lived connections, so this works
   * on Vercel Hobby without hitting the 60s function timeout.
   */
  async function pollUntilDone(chatId: string, assistantId: string) {
    const deadline = Date.now() + POLL_DEADLINE_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      let res: Response;
      try {
        res = await fetch(`/api/chat/${chatId}`, { cache: "no-store" });
      } catch {
        // transient network error — keep polling
        continue;
      }

      if (!res.ok) {
        if (res.status === 404) {
          setError("chat session not found on server");
          markDone(assistantId);
          return;
        }
        // 5xx: transient, keep polling
        continue;
      }

      const data = (await res.json()) as {
        tokens: string;
        done: boolean;
        error: string | null;
      };

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: data.tokens } : m,
        ),
      );

      if (data.error) {
        setError(data.error);
        markDone(assistantId);
        return;
      }
      if (data.done) {
        markDone(assistantId);
        return;
      }
    }

    setError("timed out waiting for reply");
    markDone(assistantId);
  }

  function markDone(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)),
    );
  }

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 860,
        margin: "0 auto",
        minHeight: "calc(100dvh - 56px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 4 }}>OpenHub Chat</h1>
        <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
          Chat with DeepSeek. The daemon holds the browser; replies stream back
          as they're produced.
        </p>
        <p style={{ color: "#999", marginTop: 0, fontSize: 12 }}>
          session: {sessionId || "…"}
        </p>
      </header>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          background: "#fafafa",
          borderRadius: 8,
          marginBottom: 16,
          minHeight: 300,
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#999", textAlign: "center", marginTop: 40 }}>
            Say something to get started.
          </p>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              background: "#fee",
              color: "#a00",
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message DeepSeek…"
          rows={2}
          disabled={busy}
          style={{
            flex: 1,
            padding: 10,
            fontSize: 14,
            fontFamily: "inherit",
            border: "1px solid #ccc",
            borderRadius: 6,
            resize: "none",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          style={{
            padding: "0 20px",
            fontSize: 14,
            border: "1px solid #ccc",
            borderRadius: 6,
            background: busy ? "#eee" : "#111",
            color: busy ? "#999" : "#fff",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </main>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: 10,
          background: isUser ? "#111" : isTool ? "#f0f7ff" : "#fff",
          color: isUser ? "#fff" : "#111",
          border: isTool ? "1px solid #cde" : "1px solid #e5e5e5",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {isTool && (
          <div
            style={{
              fontSize: 11,
              color: "#036",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            {message.tool_name}
            {message.tool_error ? " (error)" : ""}
          </div>
        )}
        {message.content || (message.streaming ? "…" : "")}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {message.toolCalls.map((tc, i) => (
              <ToolCallCard key={i} state={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallCard({ state }: { state: ToolCallState }) {
  const [open, setOpen] = useState(false);
  const color =
    state.status === "running"
      ? "#b80"
      : state.status === "error"
        ? "#a00"
        : "#080";
  const label =
    state.status === "running"
      ? "running…"
      : state.status === "error"
        ? `error after ${state.durationMs ?? "?"}ms`
        : `done in ${state.durationMs ?? "?"}ms`;

  return (
    <div
      style={{
        border: "1px solid #dde",
        borderRadius: 6,
        padding: 8,
        background: "#fbfbfe",
        fontSize: 12,
        marginTop: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          cursor: "pointer",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontFamily: "ui-monospace, monospace", color: "#036" }}>
          {state.call.name}
        </span>
        <span style={{ color }}>{label}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: "#666", marginBottom: 4 }}>args:</div>
          <pre style={pre}>{JSON.stringify(state.call.args, null, 2)}</pre>
          {state.error ? (
            <>
              <div style={{ color: "#666", marginTop: 8, marginBottom: 4 }}>
                error:
              </div>
              <pre style={pre}>{state.error}</pre>
            </>
          ) : state.status === "done" ? (
            <>
              <div style={{ color: "#666", marginTop: 8, marginBottom: 4 }}>
                result:
              </div>
              <pre style={pre}>{JSON.stringify(state.result, null, 2)}</pre>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

const pre: React.CSSProperties = {
  margin: 0,
  padding: 6,
  background: "#f4f4f4",
  borderRadius: 4,
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
