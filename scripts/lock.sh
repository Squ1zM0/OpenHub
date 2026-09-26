#!/usr/bin/env bash
#
# Regenerate pnpm-lock.yaml from a clean state.
#
# Why this exists: pnpm lockfiles are sensitive to the pnpm version and to
# any stale node_modules. When a lockfile drifts — or when Vercel's build
# fails with ERR_INVALID_THIS — regenerating from a clean slate is the fix.
#
# What it does:
#   1. Verifies corepack is available and activates the pinned pnpm version.
#   2. Ensures pnpm-lock.yaml is not gitignored.
#   3. Removes node_modules and any prior lockfile.
#   4. Runs pnpm install (writes a fresh lockfile).
#   5. Prints a summary and the git diff stat.
#
# What it does NOT do: commit. That's your call — inspect the diff first.
#
# Usage:
#   ./scripts/lock.sh              # clean regenerate
#   ./scripts/lock.sh --keep-modules   # skip rm -rf node_modules

set -euo pipefail

# ── locate repo root (this script may be run from anywhere) ─────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

KEEP_MODULES=0
for arg in "$@"; do
  case "${arg}" in
    --keep-modules) KEEP_MODULES=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: ${arg}" >&2
      exit 2
      ;;
  esac
done

# ── colours (only if stdout is a tty) ───────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YEL=$'\033[33m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi

step()  { printf '%s==>%s %s\n' "${BOLD}" "${RST}" "$*"; }
ok()    { printf '%s  ok%s %s\n' "${GRN}" "${RST}" "$*"; }
warn()  { printf '%s  warn%s %s\n' "${YEL}" "${RST}" "$*"; }
die()   { printf '%s  err%s %s\n' "${RED}" "${RST}" "$*" >&2; exit 1; }

# ── 1. read the pinned pnpm version from package.json ───────────────────────
step "reading packageManager from package.json"
if [ ! -f package.json ]; then
  die "no package.json at ${REPO_ROOT}"
fi

PINNED="$(node -e '
  const pkg = require("./package.json");
  const pm = pkg.packageManager || "";
  const m = pm.match(/^pnpm@(.+)$/);
  process.stdout.write(m ? m[1] : "");
')"

if [ -z "${PINNED}" ]; then
  die "package.json has no \"packageManager\": \"pnpm@x.y.z\" field"
fi
ok "pinned pnpm: ${PINNED}"

# ── 2. activate that version via corepack ───────────────────────────────────
step "activating pnpm@${PINNED} via corepack"
if ! command -v corepack >/dev/null 2>&1; then
  die "corepack not found. Install Node 20+ which ships corepack, then re-run."
fi

corepack enable >/dev/null 2>&1 || warn "corepack enable failed (may already be enabled)"
corepack prepare "pnpm@${PINNED}" --activate >/dev/null

ACTIVE="$(pnpm --version)"
if [ "${ACTIVE}" != "${PINNED}" ]; then
  die "pnpm is ${ACTIVE}, expected ${PINNED}. Try: corepack prepare pnpm@${PINNED} --activate"
fi
ok "pnpm ${ACTIVE}"

# ── 3. ensure the lockfile is not gitignored ────────────────────────────────
step "checking .gitignore"
if [ -f .gitignore ] && git check-ignore -q pnpm-lock.yaml 2>/dev/null; then
  die "pnpm-lock.yaml is gitignored. Remove that line from .gitignore."
fi
ok "pnpm-lock.yaml is not ignored"

# ── 4. clean node_modules and the old lockfile ──────────────────────────────
if [ "${KEEP_MODULES}" -eq 0 ]; then
  step "removing node_modules (this is the point — fresh resolve)"
  find . -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
  ok "node_modules removed"
else
  warn "keeping node_modules (--keep-modules)"
fi

if [ -f pnpm-lock.yaml ]; then
  step "backing up existing pnpm-lock.yaml to /tmp"
  cp pnpm-lock.yaml /tmp/pnpm-lock.backup.yaml
  ok "backup at /tmp/pnpm-lock.backup.yaml"
  rm -f pnpm-lock.yaml
fi

# ── 5. install ──────────────────────────────────────────────────────────────
step "running pnpm install"
if ! pnpm install; then
  printf '\n' >&2
  if [ -f /tmp/pnpm-lock.backup.yaml ]; then
    warn "install failed — restoring previous lockfile from /tmp"
    cp /tmp/pnpm-lock.backup.yaml pnpm-lock.yaml
  fi
  die "pnpm install failed. See output above."
fi
ok "install complete"

# ── 6. summary ──────────────────────────────────────────────────────────────
step "lockfile summary"
if [ ! -f pnpm-lock.yaml ]; then
  die "pnpm-lock.yaml was not produced"
fi

LOCK_LINES=$(wc -l < pnpm-lock.yaml | tr -d ' ')
LOCK_BYTES=$(wc -c < pnpm-lock.yaml | tr -d ' ')
LOCK_VER=$(grep -m1 '^lockfileVersion:' pnpm-lock.yaml | awk '{print $2}')

printf '  %s\n' "path:          pnpm-lock.yaml"
printf '  %s\n' "lockfileVer:   ${LOCK_VER:-unknown}"
printf '  %s\n' "lines:         ${LOCK_LINES}"
printf '  %s\n' "bytes:         ${LOCK_BYTES}"

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '\n'
  if git diff --quiet -- pnpm-lock.yaml 2>/dev/null; then
    ok "no change vs committed lockfile"
  else
    warn "lockfile changed. Review with: git diff --stat pnpm-lock.yaml"
    git diff --stat -- pnpm-lock.yaml | sed 's/^/  /'
    printf '\n'
    printf '  %s\n' "when ready: git add pnpm-lock.yaml && git commit -m 'chore: refresh lockfile'"
  fi
fi

printf '\n%s  done.%s\n' "${GRN}${BOLD}" "${RST}"
