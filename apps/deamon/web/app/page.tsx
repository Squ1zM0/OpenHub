"use client";

import { useState } from "react";

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tool, setTool] = useState("list_dir");
  const [args, setArgs] = useState("{}");
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createSession() {
    setBusy(true);
    setOutput(null);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const json = await res.json();
      setSessionId(json.session_id);
    } finally {
      setBusy(false);
    }
  }

  async function sendJob() {
    if (!sessionId) return;
    setBusy(true);
    setOutput(null);
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(args);
    } catch (e) {
      setOutput(`invalid args JSON: ${(e as Error).message}`);
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${sessionId}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args: parsedArgs }),
      });
      const json = await res.json();
      setOutput(JSON.stringify(json, null, 2));
    } catch (e) {
      setOutput(`request failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 32, maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>OpenHub</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Control plane. The daemon runs on your machine and polls this server.
      </p>

      <section style={{ marginTop: 32 }}>
        <button onClick={createSession} disabled={busy}>
          {sessionId ? "New session" : "Create session"}
        </button>

        {sessionId && (
          <>
            <pre style={box}>
              session_id: {sessionId}
            </pre>
            <p style={{ color: "#666" }}>In another terminal:</p>
            <pre style={box}>
              {`cd openhub/apps/daemon\n`}
              {`pnpm tsx src/index.ts login http://localhost:3000 dev-token\n`}
              {`OPENHUB_SESSION_ID=${sessionId} pnpm tsx src/index.ts start`}
            </pre>
          </>
        )}
      </section>

      {sessionId && (
        <section style={{ marginTop: 32 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label>
              tool:{" "}
              <input
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                style={input}
              />
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <label>
              args:{" "}
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                style={{ ...input, width: 400 }}
              />
            </label>
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={sendJob} disabled={busy}>
              Send job
            </button>
          </div>

          {output && <pre style={{ ...box, marginTop: 16 }}>{output}</pre>}
        </section>
      )}
    </main>
  );
}

const box: React.CSSProperties = {
  padding: 12,
  background: "#f4f4f4",
  borderRadius: 4,
  overflowX: "auto",
  fontSize: 13,
};

const input: React.CSSProperties = {
  padding: "4px 6px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  border: "1px solid #ccc",
  borderRadius: 3,
};
