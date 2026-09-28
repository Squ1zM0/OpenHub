"use client";

import { useEffect, useRef, useState } from "react";

type Status =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "restarting"; reason: "expired" | "not_found" }
  | { status: "pending"; liveUrl: string; expiresAt: number; message: string }
  | { status: "connected"; accountHint?: string; verified: string[] }
  | { status: "failed"; error: string };

export default function ConnectDeepSeek() {
  const [state, setState] = useState<Status>({ status: "idle" });
  const [connectId, setConnectId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state.status === "idle") void start();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setState({ status: "starting" });
    try {
      const res = await fetch("/api/connect/deepseek", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setConnectId(json.connectId);
      setState({
        status: "pending",
        liveUrl: json.liveUrl,
        expiresAt: json.expiresAt,
        message: "Waiting for login...",
      });
      startPolling(json.connectId);
    } catch (e) {
      setState({ status: "failed", error: (e as Error).message });
    }
  }

  function startPolling(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/connect/deepseek/${id}`);
        const json = await res.json();

        if (json.status === "connected") {
          if (pollRef.current) clearInterval(pollRef.current);
          setState({
            status: "connected",
            accountHint: json.accountHint,
            verified: json.verified ?? [],
          });
          return;
        }

        if (json.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setState({ status: "failed", error: json.error ?? "unknown error" });
          return;
        }

        if (json.status === "expired" || json.status === "not_found") {
          if (pollRef.current) clearInterval(pollRef.current);
          setState({ status: "restarting", reason: json.status });
          // Auto-restart so the user isn't stuck on a dead session.
          restartTimerRef.current = setTimeout(() => {
            void start();
          }, 1500);
          return;
        }

        if (json.status === "pending") {
          setState({
            status: "pending",
            liveUrl: json.liveUrl,
            expiresAt: json.expiresAt,
            message: json.message,
          });
          return;
        }
      } catch {
        // transient network error — keep polling
      }
    }, 2000);
  }

  async function cancel() {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    if (connectId) {
      await fetch(`/api/connect/deepseek/${connectId}/cancel`, {
        method: "POST",
      }).catch(() => {});
    }
    setState({ status: "idle" });
    setConnectId(null);
  }

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Connect DeepSeek</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Log in to DeepSeek below. Cookies and UI selectors are captured
        automatically when login succeeds.
      </p>

      {state.status === "starting" && (
        <p style={{ marginTop: 16, color: "#666" }}>
          Starting remote browser…
        </p>
      )}

      {state.status === "restarting" && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: "#fff8e8",
            border: "1px solid #f0e0b0",
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          <strong>Session timed out — restarting…</strong>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#666" }}>
            OAuth takes longer than the free Browserless tier allows. We're
            opening a fresh session so you can try again. If this keeps
            happening, do the login once on a desktop browser — cookies carry
            over, and mobile only needs a few seconds per turn.
          </p>
        </div>
      )}

      {state.status === "pending" && (
        <>
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "#e8f4ff",
              borderRadius: 6,
              fontSize: 14,
            }}
          >
            <strong>Log in to DeepSeek in the panel below.</strong> When you're
            signed in, this page will detect it and finish automatically.
          </div>

          <iframe
            src={state.liveUrl}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
            style={{
              marginTop: 16,
              width: "100%",
              height: 640,
              border: "1px solid #ccc",
              borderRadius: 6,
              background: "#fff",
            }}
            title="Browserless live browser"
          />

          <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
            <button onClick={cancel}>Cancel</button>
            <a
              href={state.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ alignSelf: "center" }}
            >
              Open in new tab ↗
            </a>
          </div>

          <p style={{ marginTop: 12, fontSize: 13, color: "#666" }}>
            If the panel above doesn't load or won't accept input, use
            "Open in new tab" instead. The login works the same either way.
          </p>
        </>
      )}

      {state.status === "connected" && (
        <div
          style={{
            marginTop: 24,
            padding: 20,
            background: "#e8ffe8",
            borderRadius: 6,
          }}
        >
          <h3 style={{ marginTop: 0 }}>Connected ✓</h3>
          {state.accountHint && (
            <p style={{ marginBottom: 8 }}>
              Account: <strong>{state.accountHint}</strong>
            </p>
          )}
          <p style={{ marginBottom: 0, fontSize: 13, color: "#555" }}>
            Verified selectors: {state.verified.join(", ") || "none"}
            <br />
            Stop and message selectors use defaults — they'll be validated on
            first use.
          </p>
          <div style={{ marginTop: 16 }}>
            <a href="/">← Back to dashboard</a>
          </div>
        </div>
      )}

      {state.status === "failed" && (
        <div style={{ marginTop: 24, color: "#a00" }}>
          <p>Connection failed: {state.error}</p>
          <button onClick={start}>Try again</button>
        </div>
      )}
    </main>
  );
}
