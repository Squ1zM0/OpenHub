# OpenHub

**Repos that describe themselves. An agent harness that builds and maintains
them — from scratch or from existing code — without guessing.**

---

## Current state

- **Phase:** GitHub App primitives landed
- **Done:** monorepo scaffold, `@openhub/manifest` schema, `@openhub/protocol`
  envelope, daemon poll loop + 10-tool registry + git checkpoint/restore,
  `apps/web` with long-poll `/api/poll`, HMAC-verified `/api/result`, session
  store, dashboard, browser→daemon→browser round trip, `@openhub/github` with
  JWT auth, token minting, branch/commit/PR operations, webhook verification
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
Local daemon (apps/daemon)      Vercel / Next (apps/web)        GitHub
   |                                |                                |
   |-- POST /api/poll ------------->|  holds ~25s                    |
   |                                |  dequeues from session store   |
   |<-- { job } or 204 -------------|                                |
   |                                |                                |
   |  execute locally               |                                |
   |                                |                                |
   |-- POST /api/result ----------->|  HMAC-verified                 |
   |    x-openhub-signature         |  saved to session store        |
   |                                |                                |
   |-- POST /api/poll ------------->|  re-poll immediately           |
   |                                |                                |
   |                                |-- commit branch + open PR ---->|
   |                                |   (installation token)         |
```

**The connection problem, and the fix.** The daemon can't accept inbound
connections (NAT, laptops, no ngrok). Vercel functions can't hold long-lived
sockets. So the connection is outbound-from-local, long-polled against Vercel.
One request held open ~25s, then the daemon re-polls instantly.

**Ephemeral executor.** The tool executor lives locally and doesn't exist
until a session opens. A `session_id` scopes the poll.

**Cloud agent, local execution.** The agent loop runs in Vercel Workflows.
The tools run on the user's machine. GitHub operations — branch, commit, PR —
run in the cloud via `@openhub/github`. The daemon never holds GitHub
credentials.

---

## Repo structure

```
openhub/
  apps/
    web/                          # @openhub/web — Next.js control plane
      app/
        api/
          poll/route.ts
          result/route.ts
          sessions/route.ts
          sessions/[id]/jobs/route.ts
          github/webhook/route.ts # verify HMAC, ack events
          github/callback/route.ts # user OAuth callback
        page.tsx
      src/lib/
        store.ts
        store-singleton.ts
        auth.ts
        tasks.ts
    daemon/                       # @openhub/daemon — local executor
      src/
        index.ts, config.ts, session.ts, snapshot.ts, git.ts, poll.ts, executor.ts
        tools/                    # 10 tools
      scripts/mock-server.ts
  packages/
    manifest/                     # zod schema for .hub/MANIFEST.json
    protocol/                     # job/result envelope + HMAC
    github/                       # GitHub App primitives ← NEW
      src/
        config.ts                 # env parsing
        app.ts                    # App instance (auth + webhooks + oauth)
        branches.ts               # get/ensure branch, sha lookup
        commits.ts                # blob → tree → commit → ref
        pulls.ts                  # open PR, find existing PR
        webhooks.ts               # HMAC verification
    capabilities/                 # (not yet) the vocabulary
    agent/                        # (not yet) shared loop logic
```

**Naming note.** `openhub/` is the monorepo. `.hub/` is the marker directory
inside every *managed* repo — including, eventually, `openhub/` itself.

---

## The GitHub App

One App, installed per user/org. Created at
https://github.com/settings/apps with these permissions:

| Scope | Permission | Why |
|-------|-----------|-----|
| Contents | Read & write | Create branches, commit files |
| Pull requests | Read & write | Open PRs, read status |
| Metadata | Read | Required by GitHub for any App |
| Webhooks | — | `push`, `pull_request`, `installation` |

The App's **private key** is PKCS#8. If you download it as PKCS#1, convert:
```
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8
```

Set the OAuth callback URL to `https://<your-domain>/api/github/callback`
and the webhook URL to `https://<your-domain>/api/github/webhook`.

### What `@openhub/github` gives you

```ts
import { readGitHubEnv, getApp, commitFiles, openPullRequest } from "@openhub/github";

const env = readGitHubEnv();
const app = getApp(env);

// Mint an installation Octokit (token cached internally, ~60 min).
const octokit = await app.getInstallationOctokit(installationId);

// Commit a set of files to a branch in one atomic commit.
const { commitSha } = await commitFiles(
  octokit, owner, repo, "openhub/task-abc",
  [{ path: "src/foo.ts", content: "export const x = 1;\n" }],
  "feat: add foo",
);

// Open a PR from that branch.
const pr = await openPullRequest(octokit, {
  owner, repo,
  title: "feat: add foo",
  body: "Generated by OpenHub.",
  head: "openhub/task-abc",
  base: "main",
});
```

**Why the Git Data API, not the Contents API.** The Contents API creates one
commit per file and can't express deletions cleanly. The Git Data API
(`createBlob` → `createTree` → `createCommit` → `updateRef`) produces a single
reviewable commit with a correct parent. That's what a PR should look like.

**Why `ensureBranch` is idempotent.** Workflow steps retry. A branch that
already exists is not a failure; it's a resume.

---

## The manifest

```jsonc
// .hub/MANIFEST.json
{
  "manifest_version": "1",
  "name": "notes",
  "kind": "web-app",
  "stack": { "framework": "next", "package_manager": "pnpm" },
  "capabilities": [
    { "name": "storage.kv", "adapter": "vercel-kv", "bind": "KV_URL" }
  ],
  "routes": [
    { "path": "/", "file": "app/page.tsx", "kind": "page" }
  ],
  "data_models": [],
  "entry_points": { "dev": "pnpm dev", "build": "pnpm build" },
  "env_required": ["KV_URL"]
}
```

Companion files in `.hub/`: `ARCHITECTURE.md`, `DECISIONS.md`,
`CAPABILITIES.json`.

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
before it writes. The state before any edit is one `git_restore` away.

**`run` never invokes a shell.** Commands are tokenized locally and passed to
`execFile`, so `;`, `|`, `&&`, `$()`, and backticks are literal characters.

**The daemon holds no GitHub credentials.** Commits and PRs happen in the
cloud via `@openhub/github`. The daemon edits files; the cloud ships them.

---

## Running it locally

```bash
cd openhub
pnpm install
cp apps/web/.env.local.example apps/web/.env.local
# fill in GITHUB_* values if you want to exercise the GitHub paths
pnpm --filter @openhub/web dev
```

Then in another terminal:

```bash
cd openhub/apps/daemon
pnpm tsx src/index.ts login http://localhost:3000 dev-token
pnpm tsx src/index.ts start
```

Open http://localhost:3000. Create a session, send a `list_dir` job, watch it
round-trip.

---

## Decisions locked

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Repo name `openhub`; npm scope `@openhub/*`; CLI `npx openhub` | Distinct; `.hub/` stays as in-repo marker |
| 2 | Tool executor runs **locally**, ephemeral | No cloud sandbox cost; user's machine is the sandbox |
| 3 | Transport: local daemon **long-polls** Vercel | Only topology that works behind NAT without relay |
| 4 | Agent loop runs in **Vercel Workflows** | Each turn is a durable step |
| 5 | Browser automation via **Browserless.io** | Chromium won't fit in Vercel's 50MB limit |
| 6 | **GitHub App**, not PAT | Webhooks + per-installation tokens |
| 7 | Both modes: from-scratch **and** existing repos | Unified by "manifest missing → generate it" |
| 8 | Capabilities, **not templates** | Composition beats snapshot |
| 9 | Daemon ships as `npx openhub` | Zero-install |
| 10 | User brings their own DeepSeek session | Dashboard is control plane |
| 11 | `manifest_version`, not `hub_version` | Schema version ≠ OpenHub version |
| 12 | **Checkpoint-before-write**, no separate snapshot store | Git is already the undo mechanism |
| 13 | `run` uses `execFile`, never a shell | Removes the injection class entirely |
| 14 | Session workspace is its own git repo | Enables checkpoint/restore without a remote |
| 15 | `SessionStore` is an interface; in-memory is dev impl | KV swap is a one-liner |
| 16 | `/api/poll` creates sessions on demand | Daemon may start before dashboard knows |
| 17 | **Git Data API** for commits, not Contents API | One commit per task; deletions work; correct parent |
| 18 | **`ensureBranch` is idempotent** | Workflow steps retry; a branch that exists is a resume |
| 19 | **Daemon holds no GitHub credentials** | Cloud does all GitHub ops; daemon only edits files |
| 20 | Webhook verification reads **raw body**, not parsed JSON | The signed bytes are the raw bytes; `req.json()` destroys them |

---

## Open questions

- **Bearer token and HMAC secret are the same in v1.** Split before deploy.
- **In-memory `SessionStore` is not correct on Vercel.** Requires KV. Blocking
  for prod, fine for local dev.
- **`@octokit/app`'s token cache is per-process.** Every serverless cold start
  mints a fresh installation token. GitHub's rate limit is generous, so this
  is probably fine for v1 — but worth measuring.
- Does the dashboard ever host chat, or is DeepSeek always the frontend?
- Capability catalog v1 scope — which 6–8 primitives cover the 90% case?
- Do we support non-Next stacks in v1?
- How is `DECISIONS.md` written — agent, user, or both?
- When the session workspace becomes a real clone (later), do checkpoints stay
  on the branch or move to a shadow ref?
- **How does the daemon's workspace become the committed files?** Options:
  (a) daemon exports changed files, cloud commits them; (b) daemon pushes via
  Git Data API with a token from the cloud; (c) daemon pushes via `git push`
  with a token. Decision pending.

---

## Build order

1. ✅ `packages/manifest` — schema landed
2. ✅ **Poll loop** — daemon ↔ web round trip proven
3. ✅ **GitHub App primitives** — auth, commit, PR, webhook verification
4. **Agent loop in Workflow** — plan → execute → verify → ship, adapter mocked
5. **DeepSeek adapter** — swap mock for Browserless
6. **Capability catalog v1** — 6–8 primitives
7. **Bootstrap** — `openhub` has its own `.hub/`

Steps 1–3 complete. Step 4 is next.

---

## Non-goals

- Not a hosted IDE.
- Not a template gallery.
- Not a chat product.
- Not multi-tenant in v1.

---

## Glossary

- **Manifest** — `.hub/MANIFEST.json`; the machine-readable description of a repo
- **Capability** — a composable primitive (`storage.kv`, `auth.session`)
- **Harness** — the agent loop + tools; not the product
- **Hub repo** — any repo containing `.hub/`
- **Session** — one open daemon connection scoped to one task
- **Job** — one tool call dispatched from the web to the daemon
- **Checkpoint** — a git commit made by a mutating tool before it writes
- **Installation token** — a ~60-minute GitHub token scoped to one App installation
- **OpenHub** — the tool. `openhub/` is its monorepo. `.hub/` is its marker.
