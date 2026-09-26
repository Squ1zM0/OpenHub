# OpenHub

**Repos that describe themselves. An agent harness that builds and maintains
them — from scratch or from existing code — without guessing.**

---

## Current state

- **Phase:** real DeepSeek adapter landed
- **Done:** monorepo scaffold, `@openhub/manifest`, `@openhub/protocol`,
  daemon poll loop + 10-tool registry + git checkpoint/restore, `apps/web`
  poll/result/sessions/tasks routes, `@openhub/github`, `@openhub/agent`
  loop + scripted adapter, DeepSeek adapter via Browserless + Playwright,
  selector discovery script
- **Next action:** capability catalog v1 — `packages/capabilities` with
  6–8 primitives and an installer
- **Blocked on:** real-world verification of DeepSeek selectors (run
  `discover-selectors` once)

---

## What this is

Most AI website builders generate a snapshot. One shot. Editing later means
the agent re-reads files with no memory of *why* anything is the way it is,
so it patches blindly or rewrites wholesale. They plateau at "demo."

OpenHub is the opposite. Every repo carries a `.hub/` directory that
describes it. The agent reads that, then edits surgically. Forever.

The harness is not the product. **The architecture is the product.**

---

## Architecture

```
Local daemon              Vercel / Next               GitHub
   |                          |                          |
   |-- POST /api/poll ------->|  holds ~25s              |
   |<-- { job } or 204 --------|                          |
   |                          |                          |
   |  execute locally         |                          |
   |                          |                          |
   |-- POST /api/result ----->|  HMAC-verified           |
   |                          |                          |
   |-- POST /api/poll ------->|  re-poll                 |
   |                          |                          |
   |                          |  agent loop:             |
   |                          |   adapter.send()         |
   |                          |    ↓                     |
   |                          |   DeepSeekAdapter        |
   |                          |    ↓ Browserless CDP     |
   |                          |   chat.deepseek.com      |
   |                          |    ↓                     |
   |                          |   tool_call parsed       |
   |                          |    ↓ sendJob             |
   |                          |    ↓ (to daemon)         |
   |                          |                          |
   |                          |-- commit + PR ---------->|
```

**Transport.** Daemon long-polls Vercel; Vercel long-polls DeepSeek. The
cloud never initiates against either. Works behind any NAT.

**Cloud agent, local execution.** The agent loop runs in the cloud. Tools
run on the user's machine. GitHub operations run in the cloud. The daemon
holds no GitHub credentials.

---

## The DeepSeek adapter

`DeepSeekAdapter` drives `chat.deepseek.com` through Browserless.io. It uses
Playwright over CDP (`chromium.connectOverCDP`) against a persistent
Browserless session.

**Lifecycle.**

1. First `send()` lazily creates a Browserless session (10 min TTL).
2. Playwright connects, injects cookies, navigates, verifies logged in.
3. Each `send()` types the delta of new transcript messages, waits for
   completion, extracts the reply.
4. `runTask` calls `close()` in a `finally` — the browser and Browserless
   session are released.

**Completion detection.** Two signals, both required:

- The stop button disappears.
- The last assistant message's text has been stable for `stabilityMs`
  (default 2000ms).

This is more robust than either alone — a re-render can briefly hide the
stop button, and a long answer can briefly pause text growth.

**Message mapping.** The web UI has no system-prompt slot, so on the first
`send()` the system message and the first user message are concatenated.
Subsequent sends push only the delta — the loop only ever appends, so a
cursor suffices.

**Selectors.** DeepSeek's class names are obfuscated and change on deploy.
The adapter is selector-agnostic: every selector is a *list of candidates*,
tried in order, first match wins. Defaults live in
`packages/agent/src/adapter/deepseek/selectors.ts` and are **educated
guesses, not verified**.

To discover the real selectors:

```bash
cd openhub
export BROWSERLESS_TOKEN=...
export DEEPSEEK_COOKIES='[...]'
pnpm --filter @openhub/agent discover-selectors
```

The script opens a Browserless session, navigates to DeepSeek, and dumps
every plausible input / button / message container, ranked. Paste the
winners into `DEEPSEEK_SELECTORS_OVERRIDE` (JSON env var) or into
`selectors.ts`.

When a selector fails at runtime, the adapter throws a message that names
the tried candidates — clear enough to know exactly what broke.

**ToS note.** Automating a logged-in DeepSeek session may violate DeepSeek's
terms. This adapter is built for personal, single-user, local use against
your own account. Do not point it at accounts you don't own; do not use it
commercially without checking the terms; do not bypass rate limits.

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
        tasks/route.ts            # run one agent task
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
    agent/                        # agent loop + adapters
      src/
        types.ts                  # Message, ToolCall, AgentEvent, parser
        prompt.ts                 # the standing system prompt
        adapter.ts                # Adapter interface + ScriptedAdapter
        loop.ts                   # runTask — the loop itself
        adapter/deepseek/         # Browserless + Playwright adapter
          types.ts                # config, env, cookie shape
          selectors.ts            # default candidates (guesses)
          browserless.ts          # session create / stop
          adapter.ts              # DeepSeekAdapter
          index.ts
      scripts/
        discover-selectors.ts     # run once to find real selectors
    capabilities/                 # (not yet) the vocabulary
```

---

## The agent loop

`runTask` takes a **task**, an **adapter**, and a **dispatcher**. It returns
a transcript, an event log, and a status. `adapter.close?.()` runs in a
`finally`, so browser sessions don't leak.

The wire format: the model emits `<tool_call name="X">{json}</tool_call>`,
the loop parses, dispatches, and injects
`<tool_result name="X">{json}</tool_result>` back as the next user message.
One tool call per message. No call = final answer.

Two adapters ship:

- `ScriptedAdapter` — deterministic, for tests and the demo. Takes a
  sequence of responses, optionally gated on the previous message.
- `DeepSeekAdapter` — the real one. Browserless + Playwright, drives the
  web UI.

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

Checkpoints are automatic on every mutating tool. `run` never invokes a
shell.

---

## Running it locally

```bash
cd openhub
pnpm install
cp apps/web/.env.local.example apps/web/.env.local
# fill in BROWSERLESS_TOKEN and DEEPSEEK_COOKIES for the real adapter
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
3. Choose **scripted** or **deepseek**.
4. Type a task and click **Run task**.

With the scripted adapter, the demo writes `notes.txt` and reads it back.
With the DeepSeek adapter, the real model plans, calls tools, and finishes.

---

## Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Repo name `openhub`; scope `@openhub/*`; CLI `npx openhub` | Distinct; `.hub/` is the in-repo marker |
| 2 | Tool executor runs **locally**, ephemeral | User's machine is the sandbox |
| 3 | Transport: daemon **long-polls** Vercel | Works behind NAT without relay |
| 4 | Agent loop runs in **Vercel Workflows** (or `/api/tasks` in demo) | Durable steps |
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
| 21 | Agent loop lives in **`packages/agent`** | Reusable, testable, framework-free |
| 22 | **Tool calls are XML-tagged JSON** | Works with any chat UI |
| 23 | **One tool call per message**; no call = final | Simple parser, clear termination |
| 24 | The system prompt is the **contract** | Fix the prompt, not the parser |
| 25 | Tool results are injected as **user messages** | Only two roles in a chat UI |
| 26 | **Selectors are candidate lists**, not single strings | Obfuscated class names drift on deploy |
| 27 | **Completion = stop-button-gone AND text-stable** | Either alone is unreliable |
| 28 | **Lazy session open, explicit `close()`** | The adapter is stateful; the loop is the lifecycle owner |
| 29 | **System prompt concatenated into first user message** | DeepSeek UI has no system slot |
| 30 | **Delta-only sends** via a cursor | The chat keeps history; re-sending would duplicate |

---

## Open questions

- **Bearer token and HMAC secret are the same in v1.** Split before deploy.
- **In-memory `SessionStore` is not correct on Vercel.** Requires KV.
- **DeepSeek selector defaults are unverified.** Run `discover-selectors`
  once and commit the real values (or note them for the user to set).
- **Vercel function timeout vs. DeepSeek latency.** A full task may exceed
  `maxDuration: 300`. The Workflows migration is the fix; for now the demo
  route will 504 on long tasks.
- **Browserless free tier concurrency.** One session per task. Concurrent
  tasks need a plan upgrade or a queue.
- **No streaming.** The loop returns all events at once. For long tasks the
  dashboard should stream. Deferred.
- Capability catalog v1 scope — which 6–8 primitives cover the 90% case?
- Do we support non-Next stacks in v1?
- How does the daemon's workspace become the committed files? (export /
  push via API / push via git) — decision pending.
- Does the dashboard ever host chat, or is DeepSeek always the frontend?
- How is `DECISIONS.md` written — agent, user, or both?

---

## Build order

1. ✅ `packages/manifest`
2. ✅ **Poll loop**
3. ✅ **GitHub App primitives**
4. ✅ **Agent loop** — `runTask`, scripted adapter
5. ✅ **DeepSeek adapter** — Browserless + Playwright, discovery script
6. **Capability catalog v1** — 6–8 primitives + installer
7. **Bootstrap** — `openhub` has its own `.hub/`

Steps 1–5 complete. Step 6 is next.

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
- **Tool call** — the model's request, as `<tool_call>` XML
- **Tool result** — the daemon's response, as `<tool_result>` XML
- **Adapter** — the model interface; `ScriptedAdapter` or `DeepSeekAdapter`
- **Dispatcher** — the loop's hook to the daemon
- **Checkpoint** — a git commit made before a mutating tool writes
- **Browserless session** — one remote Chromium, TTL-bounded
- **OpenHub** — the tool. `openhub/` is its monorepo. `.hub/` is its marker.
