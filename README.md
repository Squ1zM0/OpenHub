# OpenHub

**Repos that describe themselves. An agent harness that builds and maintains
them — from scratch or from existing code — without guessing.**

---

## Current state

- **Phase:** poll protocol proven end-to-end
- **Done:** monorepo scaffold, `@openhub/manifest` schema, `@openhub/protocol`
  envelope, daemon poll loop, 10-tool registry, git-backed checkpoint/restore,
  `apps/web` with long-poll `/api/poll`, HMAC-verified `/api/result`, session
  store, dashboard, browser→daemon→browser round trip
- **Next action:** `packages/agent` — the shared loop logic (plan → execute →
  verify → ship) with the DeepSeek adapter mocked
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
   routes, data models, capabilities, env vars, entry points. The agent never
   reads every file to understand a repo. It reads this, then fetches only what
   the task implicates.

2. **A capability vocabulary.** Not templates ("here's a blog") but primitives
   ("here's `storage.kv`, `auth.session`, `email.transactional`"). The agent
   composes them. Generated code never hardcodes a backend, so swapping later
   is a manifest edit, not a refactor.

3. **GitHub as the filesystem.** Every task = branch + PR. Rollback is
   `git revert`. Audit is the commit log + ADR log. Preview deploys come free
   from Vercel. The preview loop — branch → deploy → agent hits live URL →
   pass/fail → merge — is the moat. Template tools structurally cannot do this.

---

## Architecture

```
Local daemon (apps/daemon)      Vercel / Next (apps/web)
   |                                |
   |-- POST /api/poll ------------->|  holds ~25s
   |                                |  dequeues from session store
   |<-- { job } or 204 -------------|
   |                                |
   |  execute locally               |
   |                                |
   |-- POST /api/result ----------->|  HMAC-verified
   |    x-openhub-signature         |  saved to session store
   |                                |
   |-- POST /api/poll ------------->|  re-poll immediately
```

**The connection problem, and the fix.** The daemon can't accept inbound
connections (NAT, laptops, no ngrok). Vercel functions can't hold long-lived
sockets. So the connection is outbound-from-local, long-polled against Vercel.
One request held open ~25s, then the daemon re-polls instantly. Latency to
first tool call: sub-second. No third-party relay, no WebSocket fragility,
works behind any NAT.

**Ephemeral executor.** The tool executor lives locally and doesn't exist
until a session opens. A `session_id` scopes the poll. When the session
closes, polls stop, the workflow stalls, and it eventually times out and
marks the task abandoned. No cleanup logic — cleanup is just absence of
polling.

**Cloud agent, local execution.** The agent loop runs in Vercel Workflows.
The tools run on the user's machine. This is the split.

---

## Repo structure

```
openhub/                          # monorepo, this is the product
  apps/
    web/                          # @openhub/web — Next.js control plane
      app/
        api/
          poll/route.ts           # daemon long-polls here
          result/route.ts         # daemon posts HMAC-signed results here
          sessions/route.ts       # create/list sessions
          sessions/[id]/jobs/     # enqueue a job and wait for its result
        page.tsx                  # minimal dashboard
      src/lib/
        store.ts                  # SessionStore interface + InMemory impl
        store-singleton.ts        # globalThis-attached, survives HMR
        auth.ts                   # bearer + HMAC verify
        tasks.ts                  # sendJob: enqueue + wait
    daemon/                       # @openhub/daemon — runs on user machine
      src/
        index.ts                  # poll loop
        config.ts                 # ~/.openhub/config.json
        session.ts                # per-session workspace + git init
        snapshot.ts               # ensureRepo + checkpoint
        git.ts                    # git CLI wrapper
        poll.ts                   # long-poll + result post
        executor.ts               # job → tool dispatch
        tools/                    # read_file, list_dir, search, write_file,
                                  # apply_patch, run, git_status, git_diff,
                                  # git_restore, git_commit
  packages/
    manifest/                     # zod schema for .hub/MANIFEST.json
    protocol/                     # job/result envelope + HMAC
    capabilities/                 # (not yet) the vocabulary
    github/                       # (not yet) App auth, installation tokens
    agent/                        # (not yet) shared loop logic
```

**Naming note.** `openhub/` is the monorepo. `.hub/` is the marker directory
that appears inside every *managed* repo — including, eventually, `openhub/`
itself at bootstrap step 7. Different things, same word, related by intent.

---

## The manifest

```jsonc
// .hub/MANIFEST.json
{
  "manifest_version": "1",
  "name": "notes",
  "kind": "web-app",              // web-app | api | worker | static | cli
  "stack": {
    "framework": "next",
    "runtime": "node20",
    "package_manager": "pnpm"
  },
  "capabilities": [
    { "name": "storage.kv",         "adapter": "vercel-kv", "bind": "KV_URL" },
    { "name": "storage.blob",       "adapter": "vercel-blob" },
    { "name": "auth.session",       "adapter": "authjs", "providers": ["github"] },
    { "name": "email.transactional","adapter": "resend" }
  ],
  "routes": [
    { "path": "/",          "file": "app/page.tsx",            "kind": "page" },
    { "path": "/api/notes", "file": "app/api/notes/route.ts",  "kind": "api" }
  ],
  "data_models": [
    { "name": "Note",
      "fields": { "id": "uuid", "body": "text", "created_at": "timestamp" },
      "store": "storage.kv" }
  ],
  "entry_points": { "dev": "pnpm dev", "build": "pnpm build", "test": "pnpm test" },
  "env_required": ["KV_URL", "AUTH_SECRET", "GITHUB_ID", "GITHUB_SECRET"]
}
```

Companion files in `.hub/`:

- `ARCHITECTURE.md` — why it's shaped this way
- `DECISIONS.md` — append-only ADR log; agent reads before proposing changes
- `CAPABILITIES.json` — which primitives are wired in, and where

---

## Capabilities

Each capability is a folder with a fixed shape:

```
packages/capabilities/storage/kv/
  capability.json     # name, version, deps, exposed interface
  scaffold/           # files to copy in if the repo lacks them
  adapters/
    vercel-kv.ts
    upstash.ts
    sqlite.ts         # dev fallback — local mode without cloud
  wiring.json         # entries to merge into MANIFEST.json on install
  smoke.test.ts       # harness runs this after install
```

Installing a capability = copy scaffold + merge wiring into the manifest +
run smoke tests. That's it.

The agent **composes capabilities; it does not invent libraries.** When the
user asks for something no capability covers, that's a signal to write a new
capability — which becomes part of the vocabulary for every future project.

---

## The daemon's tool surface (v1)

| Tool | Purpose |
|------|---------|
| `list_dir` | Depth-limited directory listing, ignore-aware |
| `read_file` | UTF-8 read with line range + byte cap |
| `search` | Regex search over text files |
| `write_file` | Whole-file write; checkpoints before overwriting |
| `apply_patch` | Unified diff; the primary editing tool |
| `run` | Allowlisted command execution, no shell |
| `git_status` | Branch, HEAD, working-tree entries |
| `git_diff` | Working-tree or staged diff, optionally scoped |
| `git_restore` | Revert a file to a prior ref (default HEAD) |
| `git_commit` | Explicit commit for narrative history |

**Checkpoints are automatic.** Every mutating tool (`write_file`,
`apply_patch`) commits the current tree before it writes. So the state
immediately prior to any edit is always one `git_restore` away.

**`run` never invokes a shell.** Commands are tokenized locally and passed to
`execFile`, so `;`, `|`, `&&`, `$()`, and backticks are literal characters,
not operators.

---

## Running it locally

Two terminals. First, the control plane:

```bash
cd openhub
pnpm install
cp apps/web/.env.local.example apps/web/.env.local
pnpm --filter @openhub/web dev
```

Open http://localhost:3000. Click **Create session**. The page prints the
`session_id` and the exact daemon command to run.

Second terminal, the daemon:

```bash
cd openhub/apps/daemon
pnpm tsx src/index.ts login http://localhost:3000 dev-token
OPENHUB_SESSION_ID=<id-from-the-page> pnpm tsx src/index.ts start
```

Now click **Send job** on the page with the default `list_dir` / `{}`. The
flow is:

1. Browser → `POST /api/sessions/<id>/jobs`
2. Server enqueues a `Job` in the session store, then polls for the result
3. Daemon's open poll request returns the job
4. Daemon executes `list_dir` against its session workspace
5. Daemon → `POST /api/result` with an HMAC signature
6. Server verifies, stores the result
7. The waiting `sendJob` call sees it and returns
8. Browser renders the JSON

That round trip is the third anchor. Everything downstream — GitHub App,
workflow, adapter, preview loop — plugs into this shape.

---

## The manifest

(see above)

---

## Security

- Daemon authenticates via bearer token; results are HMAC-signed with the
  same token (v1 simplification — see Open Questions).
- Session-scoped work items. A hostile Vercel function can't drive another
  session's daemon without the token.
- Working dir per session in `~/.openhub/sessions/<id>/`, wiped on close.
- Destructive tools (`rm`, force-push, DB drop) require an approval click in
  the web UI, delivered as a special work item. *(not yet implemented)*
- `run` is allowlisted by first token, with a two-token deny list.

---

## Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Repo name `openhub`; npm scope `@openhub/*`; CLI `npx openhub` | Distinct on npm/GitHub; `.hub/` stays as the in-repo marker |
| 2 | Tool executor runs **locally**, ephemeral | No cloud sandbox cost; user's machine is the sandbox |
| 3 | Transport: local daemon **long-polls** Vercel | Only topology that works behind NAT without relay |
| 4 | Agent loop runs in **Vercel Workflows** | Each turn is a durable step; survives function timeouts |
| 5 | Browser automation via **Browserless.io** | Playwright/Chromium won't fit in Vercel's 50MB limit |
| 6 | **GitHub App**, not PAT | Webhooks + per-installation tokens; needed for preview loop |
| 7 | Both modes: from-scratch **and** existing repos | Unified by the "manifest missing → generate it" conditional |
| 8 | Capabilities, **not templates** | Composition beats snapshot; enables indefinite editing |
| 9 | Daemon ships as `npx openhub` | Zero-install; needs Node on user machine (acceptable v1) |
| 10 | User brings their own DeepSeek session | Dashboard is control plane, not chat host; avoids login automation |
| 11 | Manifest schema version field is `manifest_version`, **not** `hub_version` | Schema version ≠ OpenHub version |
| 12 | **Checkpoint-before-write**, no separate snapshot store | Git is already the undo mechanism |
| 13 | `run` uses `execFile`, never a shell | Removes the injection class entirely |
| 14 | Session workspace is its own git repo | Enables checkpoint/restore without a remote clone |
| 15 | `SessionStore` is an interface; in-memory is the dev impl | Keeps the KV swap a one-liner; makes dev-to-prod honest |
| 16 | `/api/poll` creates sessions on demand | Daemon may start before the dashboard has heard of the session |

---

## Open questions

- **Bearer token and HMAC secret are the same in v1.** Should be split:
  per-session auth token, per-user signing key. Do this before any real
  deployment.
- **In-memory SessionStore is not correct on Vercel.** Two invocations
  (`/api/poll`, `/api/result`) will not share memory. Requires Vercel KV.
  Blocking for prod, fine for local dev.
- Does the dashboard ever host chat, or is DeepSeek always the frontend?
- Capability catalog v1 scope — which 6–8 primitives cover the 90% case?
- Do we support non-Next stacks in v1?
- How is `DECISIONS.md` written — by the agent, the user, or both?
- When the session workspace is a real clone (later), do checkpoints stay on
  the branch or move to a shadow ref?

---

## Build order

1. ✅ `packages/manifest` — schema landed
2. ✅ **Poll loop** — daemon ↔ web round trip proven via dashboard
3. **GitHub App** — OAuth, installation tokens, PR open
4. **Agent loop in Workflow** — plan → execute → verify → ship, adapter mocked
5. **DeepSeek adapter** — swap mock for Browserless
6. **Capability catalog v1** — 6–8 primitives
7. **Bootstrap** — `openhub` has its own `.hub/`; use the harness to add the
   next capability to itself

Steps 1–2 complete. Step 3 is next.

---

## Non-goals

- Not a hosted IDE. The user's editor stays the user's editor.
- Not a template gallery. There is no "pick a theme" step.
- Not a chat product. Chat is the input method, not the artifact.
- Not multi-tenant in v1. Single user, single machine, many repos.

---

## Glossary

- **Manifest** — `.hub/MANIFEST.json`; the machine-readable description of a repo
- **Capability** — a composable primitive (`storage.kv`, `auth.session`)
- **Harness** — the agent loop + tools; not the product
- **Hub repo** — any repo containing `.hub/`; native to the architecture
- **Session** — one open daemon connection scoped to one task
- **Job** — one tool call dispatched from the web to the daemon
- **Checkpoint** — a git commit made by a mutating tool before it writes
- **Control plane** — `apps/web`; the Vercel side that coordinates tasks
- **OpenHub** — the tool. `openhub/` is its monorepo. `.hub/` is its marker.
