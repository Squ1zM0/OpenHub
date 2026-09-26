"use client";

import { useState } from "react";

interface TaskResponse {
  status: string;
  final_message: string;
  turns: number;
  error: string | null;
  events: Array<Record<string, unknown>>;
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tool, setTool] = useState("list_dir");
  const [args, setArgs] = useState("{}");
  const [output, setOutput] = useState<string | null>(null);

  const [task, setTask] = useState(
    "Create a file called notes.txt with the content 'hello from openhub'.",
  );
  const [taskOutput, setTaskOutput] = useState<TaskResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function createSession() {
    setBusy(true);
    setOutput(null);
    setTaskOutput(null);
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

  async function runTask() {
    if (!sessionId) return;
    setBusy(true);
    setTaskOutput(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, task }),
      });
      const json = (await res.json()) as TaskResponse;
      setTaskOutput(json);
    } catch (e) {
      setTaskOutput({
        status: "error",
        final_message: "",
        turns: 0,
        error: (e as Error).message,
        events: [],
      });
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
            <pre style={box}>session_id: {sessionId}</pre>
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
        <>
          <section style={{ marginTop: 32 }}>
            <h3 style={{ marginBottom: 8 }}>Run an agent task</h3>
            <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
              Scripted adapter for now — the loop runs end-to-end but the
              model is a fixed sequence. Swap for the DeepSeek adapter later.
            </p>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              style={{ ...input, width: "100%", fontFamily: "inherit" }}
            />
            <div style={{ marginTop: 12 }}>
              <button onClick={runTask} disabled={busy}>
                Run task
              </button>
            </div>

            {taskOutput && (
              <>
                <div style={{ marginTop: 16, fontSize: 14 }}>
                  <strong>status:</strong> {taskOutput.status}
                  {" · "}
                  <strong>turns:</strong> {taskOutput.turns}
                  {taskOutput.error && (
                    <>
                      {" · "}
                      <strong>error:</strong> {taskOutput.error}
                    </>
                  )}
                </div>
                {taskOutput.final_message && (
                  <p style={{ marginTop: 8 }}>{taskOutput.final_message}</p>
                )}
                <pre style={{ ...box, marginTop: 12, maxHeight: 400, overflow: "auto" }}>
                  {taskOutput.events.map((e) => JSON.stringify(e)).join("\n")}
                </pre>
              </>
            )}
          </section>

          <section style={{ marginTop: 32 }}>
            <h3 style={{ marginBottom: 8 }}>Send a raw job</h3>
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
        </>
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
