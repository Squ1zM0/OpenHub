# OpenHub

**Repos that describe themselves. An agent harness that builds and maintains
them — from scratch or from existing code — without guessing.**

---

## Current state

- **Phase:** agent loop working end-to-end (scripted adapter)
- **Done:** monorepo scaffold, `@openhub/manifest`, `@openhub/protocol`,
  daemon poll loop + 10-tool registry + git checkpoint/restore, `apps/web`
  poll/result/sessions routes, `@openhub/github` (auth, commit, PR, webhook
  verify), `@openhub/agent` (loop, protocol parser, prompt, scripted adapter),
  `/api/tasks` demo route
- **Next action:** DeepSeek adapter — swap `ScriptedAdapter` for a Browserless
  round trip, then wire it into the workflow
- **Blocked on:** nothing

---

## What this is

Most AI website builders (v0, Lovable, Bolt) generate a snapshot. One shot.
Editing later means the agent re-reads files with no memory of *why* anything
is the way it is, so it patches blindly or rewrites wholesale. They plateau at
"demo" because they have no durable model of the project.

OpenHub is the opposite. Every repo — generated or adopted — carries a `.hub/`
directory that describes it. The agent reads that, then edits surgically.
Forever. The same harness that created the repo can maintain it.

The harness is not the product. **The architecture is the product.**
The harness is just the thing that writes into it.

---

## The core insight

Three pieces, and none of them work without the other two:

1. **A manifest.** `.hub/MANIFEST.json` — machine-readable description of
   routes, data models, capabilities, env vars, entry points.
2. **A capability vocabulary.** Not templates but primitives. The agent
   composes them.
3. **GitHub as the filesystem.** Every task = branch + PR. Rollback is
   `git revert`. Preview deploys come free from Vercel.

---

## Architecture

```
Local daemon (apps/daemon)   Vercel / Next (apps/web)         GitHub
   |                             |                                |
   |-- POST /api/poll ---------->|  holds ~25s                    |
   |<-- { job } or 204 ----------|                                |
   |                             |                                |
   |  execute locally            |                                |
   |                             |                                |
   |-- POST /api/result -------->|  HMAC-verified                 |
   |                             |                                |
   |-- POST /api/poll ---------->|  re-poll                       |
   |                             |                                |
   |                             |  ┌───────────────────────┐     |
   |                             |  │ agent loop (pkg)      │     |
   |                             |  │  adapter → tool call  │     |
   |                             |  │  dispatch → sendJob   │     |
   |                             |  │  inject result        │     |
   |                             |  └───────────────────────┘     |
   |                             |                                |
   |                             |-- commit branch + PR --------->|
```

**The connection problem, and the fix.** The daemon can't accept inbound
connections (NAT, laptops, no ngrok). Vercel functions can't hold long-lived
sockets. So the connection is outbound-from-local, long-polled against Vercel.

**Cloud agent, local execution.** The agent loop runs in the cloud (or in
`/api/tasks` for the demo). Tools run on the user's machine. GitHub operations
run in the cloud. The daemon holds no GitHub credentials.

---

## Repo structure

```
openhub/
  apps/
    web/                          # @openhub/web — Next.js control plane
      app/api/
        poll/route.ts
        result/route.ts
        sessions/route.ts
        sessions/[id]/jobs/route.ts
        tasks/route.ts            # run one agent task ← NEW
        github/webhook/route.ts
        github/callback/route.ts
      src/lib/{store,store-singleton,auth,tasks}.ts
    daemon/                       # @openhub/daemon — local executor
      src/{index,config,session,snapshot,git,poll,executor}.ts
      src/tools/                  # 10 tools
      scripts/mock-server.ts
  packages/
    manifest/                     # zod schema for .hub/MANIFEST.json
    protocol/                     # job/result envelope + HMAC
    github/                       # GitHub App primitives
    agent/                        # agent loop, protocol, prompt, adapters ← NEW
      src/
        types.ts                  # Message, ToolCall, AgentEvent, parser
        prompt.ts                 # the standing system prompt
        adapter.ts                # Adapter interface + ScriptedAdapter
        loop.ts                   # runTask — the loop itself
        index.ts
    capabilities/                 # (not yet) the vocabulary
```

---

## The agent loop

`runTask` is the whole harness in one function. It takes:

- a **task** — plain English
- an **adapter** — anything implementing `send(messages) → response`
- a **dispatcher** — `(tool, args) => result`, which is what talks to the daemon

It returns a transcript, an event log, and a status. No imports from the web
app — the caller wires everything in.

```ts
const result = await runTask({
  task: "Create notes.txt with 'hello'.",
  adapter: new ScriptedAdapter([...]),
  dispatch: async (tool, args) => {
    const res = await sendJob(sessionId, tool, args, 30_000);
    return res.status === "ok"
      ? { status: "ok", result: res.result.result, durationMs: 0 }
      : { status: "error", error: res.error, durationMs: 0 };
  },
});
```

**The wire format.** The model emits `<tool_call name="X">{json}</tool_call>`.
The loop parses it, dispatches, and injects
`<tool_result name="X">{json}</tool_result>` back as the next user message.
One tool call per message. If a message contains no tool call, the loop
treats it as final and returns.

**Why the loop lives in `packages/agent`, not `apps/web`.** It's reusable.
The workflow layer will wrap it. Tests can drive it with a fake dispatcher.
The web route is one of several possible entry points.

**The system prompt is the contract.** Same text reaches every adapter — the
mock, the future DeepSeek adapter, an OpenAI-compatible endpoint. If the
model drifts, we fix the prompt, not the parser.

---

## The daemon's tool surface (v1)

| Tool | Purpose |
|------|---------|
| `list_dir` | Depth-limited directory listing |
| `read_file` | UTF-8 read with line range + byte cap |
| `search` | Regex search over text files |
| `write_file` | Whole-file write; checkpoints before overwriting |
| `apply_patch` | Unified diff; the primary editing tool |
| `run` | Allowlisted command execution, no shell |
| `git_status` | Branch, HEAD, working-tree entries |
| `git_diff` | Working-tree or staged diff |
| `git_restore` | Revert a file to a prior ref |
| `git_commit` | Explicit commit for narrative history |

**Checkpoints are automatic.** Every mutating tool commits the current tree
before it writes.

**`run` never invokes a shell.** Tokenized locally, passed to `execFile`.

---

## Running it locally

```bash
cd openhub
pnpm install
cp apps/web/.env.local.example apps/web/.env.local
pnpm --filter @openhub/web dev
```

In another terminal:

```bash
cd openhub/apps/daemon
pnpm tsx src/index.ts login http://localhost:3000 dev-token
OPENHUB_SESSION_ID=<id-from-the-page> pnpm tsx src/index.ts start
```

On http://localhost:3000:

1. **Create session.**
2. Start the daemon with the printed `OPENHUB_SESSION_ID`.
3. Type a task in the **Run an agent task** box and click **Run task**.
4. Watch the event log stream in. The scripted adapter will `write_file` a
   `notes.txt` into the daemon's workspace, then `read_file` it back, then
   finish.

That round trip — browser → agent loop → dispatcher → daemon → tool → result
→ back into the loop → final — is the fifth anchor.

---

## Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Repo name `openhub`; scope `@openhub/*`; CLI `npx openhub` | Distinct; `.hub/` is the in-repo marker |
| 2 | Tool executor runs **locally**, ephemeral | User's machine is the sandbox |
| 3 | Transport: daemon **long-polls** Vercel | Works behind NAT without relay |
| 4 | Agent loop runs in **Vercel Workflows** | Durable steps; survives timeouts |
| 5 | Browser automation via **Browserless.io** | Chromium won't fit in Vercel's 50MB limit |
| 6 | **GitHub App**, not PAT | Webhooks + per-installation tokens |
| 7 | Both modes: from-scratch **and** existing repos | "Manifest missing → generate it" unifies them |
| 8 | Capabilities, **not templates** | Composition beats snapshot |
| 9 | Daemon ships as `npx openhub` | Zero-install |
| 10 | User brings their own DeepSeek session | Dashboard is control plane |
| 11 | `manifest_version`, not `hub_version` | Schema version ≠ OpenHub version |
| 12 | **Checkpoint-before-write** | Git is the undo mechanism |
| 13 | `run` uses `execFile`, never a shell | Removes injection class |
| 14 | Session workspace is its own git repo | Checkpoint/restore without a remote |
| 15 | `SessionStore` is an interface; in-memory is dev impl | KV swap is a one-liner |
| 16 | `/api/poll` creates sessions on demand | Daemon may start before dashboard knows |
| 17 | **Git Data API** for commits | One commit per task; deletions work |
| 18 | **`ensureBranch` is idempotent** | Workflow steps retry |
| 19 | **Daemon holds no GitHub credentials** | Cloud does all GitHub ops |
| 20 | Webhook verification reads **raw body** | `req.json()` destroys signed bytes |
| 21 | Agent loop lives in **`packages/agent`**, not the web app | Reusable, testable, framework-free |
| 22 | **Tool calls are XML-tagged JSON** in the assistant message | Works with any chat UI; no native tool-call API required |
| 23 | **One tool call per message**; no call = final | Simple parser, clear termination condition |
| 24 | The system prompt is the **contract** between harness and model | If the model drifts, fix the prompt, not the parser |
| 25 | Tool results are injected as **user messages** with `<tool_result>` | Only two roles in a chat UI; user is the correct bucket |

---

## Open questions

- **Bearer token and HMAC secret are the same in v1.** Split before deploy.
- **In-memory `SessionStore` is not correct on Vercel.** Requires KV.
- **`@octokit/app`'s token cache is per-process.** Cold starts mint fresh
  installation tokens. Probably fine for v1; measure.
- **How does the daemon's workspace become the committed files?** Options:
  (a) daemon exports changed files, cloud commits;
  (b) daemon pushes via Git Data API with a token from the cloud;
  (c) daemon pushes via `git push` with a token. Decision pending.
- Does the dashboard ever host chat, or is DeepSeek always the frontend?
- Capability catalog v1 scope — which 6–8 primitives cover the 90% case?
- Do we support non-Next stacks in v1?
- How is `DECISIONS.md` written — agent, user, or both?
- When the session workspace becomes a real clone, do checkpoints stay on the
  branch or move to a shadow ref?
- **Streaming events.** Currently the loop returns all events at once. For
  long tasks the dashboard should stream. Options: Server-Sent Events, or
  the workflow's built-in step stream. Deferred.

---

## Build order

1. ✅ `packages/manifest` — schema
2. ✅ **Poll loop** — daemon ↔ web round trip
3. ✅ **GitHub App primitives** — auth, commit, PR, webhook verify
4. ✅ **Agent loop** — `runTask`, scripted adapter, `/api/tasks` demo
5. **DeepSeek adapter** — swap mock for Browserless
6. **Capability catalog v1** — 6–8 primitives
7. **Bootstrap** — `openhub` has its own `.hub/`

Steps 1–4 complete. Step 5 is next.

---

## Non-goals

- Not a hosted IDE.
- Not a template gallery.
- Not a chat product.
- Not multi-tenant in v1.

---

## Glossary

- **Manifest** — `.hub/MANIFEST.json`
- **Capability** — a composable primitive (`storage.kv`, `auth.session`)
- **Harness** — the agent loop + tools; not the product
- **Hub repo** — any repo containing `.hub/`
- **Session** — one open daemon connection scoped to one task
- **Job** — one tool call dispatched from the web to the daemon
- **Tool call** — the model's request to run a tool, as `<tool_call>` XML
- **Tool result** — the daemon's response, injected back as `<tool_result>`
- **Adapter** — the model interface; `ScriptedAdapter` is the current one
- **Dispatcher** — the loop's hook to send a tool call to the daemon
- **Checkpoint** — a git commit made by a mutating tool before it writes
- **OpenHub** — the tool. `openhub/` is its monorepo. `.hub/` is its marker.
