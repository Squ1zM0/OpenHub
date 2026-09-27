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
  tool_args?: unknown;
  tool_result?: unknown;
  tool_error?: string;
  tool_calls?: ToolCall[];
  // client-side only
  streaming?: boolean;
  toolCalls?: ToolCallState[];
}

let msgCounter = 0;
const nextId = () => `m-${++msgCounter}-${Date.now()}`;

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // One chat session per page mount. Persist to localStorage so reloads
  // keep the thread.
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
    setMessages((prev) => [...prev, userMsg]);

    // The assistant message we'll stream into.
    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", streaming: true, toolCalls: [] },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          handleEvent(event, assistantId);
        }
      }
    } catch (e) {
      setError((e as Error).message);
      markAssistantDone(assistantId);
    } finally {
      setBusy(false);
      markAssistantDone(assistantId);
    }
  }

  function handleEvent(event: Record<string, unknown>, assistantId: string) {
    const type = event.type as string;

    if (type === "message_delta") {
      const delta = String(event.text ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + delta } : m,
        ),
      );
      return;
    }

    if (type === "assistant_done") {
      const text = String(event.text ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: text, streaming: false } : m,
        ),
      );
      return;
    }

    if (type === "tool_call_start") {
      const call = event.call as ToolCall;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const existing = m.toolCalls ?? [];
          return {
            ...m,
            toolCalls: [...existing, { call, status: "running" }],
          };
        }),
      );
      return;
    }

    if (type === "tool_call_done") {
      const call = event.call as ToolCall;
      const error = event.error as string | null;
      const durationMs = event.durationMs as number | undefined;
      const result = event.result;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const list = m.toolCalls ?? [];
          return {
            ...m,
            toolCalls: list.map((tc) =>
              tc.call.raw === call.raw
                ? {
                    ...tc,
                    status: error ? "error" : "done",
                    result,
                    error: error ?? undefined,
                    durationMs,
                  }
                : tc,
            ),
          };
        }),
      );
      return;
    }

    if (type === "error") {
      setError(String(event.message ?? "unknown error"));
      return;
    }
  }

  function markAssistantDone(assistantId: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, streaming: false } : m,
      ),
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 860, margin: "0 auto", minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 4 }}>OpenHub Chat</h1>
        <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
          Chat with DeepSeek. Tool calls execute on your local daemon and
          stream back into the conversation.
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
          <div style={{ fontSize: 11, color: "#036", marginBottom: 6, fontWeight: 600 }}>
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
        style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}
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
              <div style={{ color: "#666", marginTop: 8, marginBottom: 4 }}>error:</div>
              <pre style={pre}>{state.error}</pre>
            </>
          ) : state.status === "done" ? (
            <>
              <div style={{ color: "#666", marginTop: 8, marginBottom: 4 }}>result:</div>
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
