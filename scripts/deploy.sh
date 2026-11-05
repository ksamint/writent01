#!/usr/bin/env bash
# Local Cloudflare deploy for writer-tracker (writent01), run from the
# operator's machine.
#
# Replaces .github/workflows/deploy.yml (removed 2026-11-05, owner decision:
# no GitHub Actions and no runners).
#
# Usage: scripts/deploy.sh <target> [<target> ...]
#   worker  npm install + `wrangler deploy` (Worker from wrangler.toml)
#   seed    `wrangler d1 execute writer-tracker-db --file=data/seed.sql`,
#           exactly as the workflow ran it (no --remote: with wrangler 3
#           this targets local D1 state, not the production database)
#   pages   `wrangler pages deploy public --project-name=writer-tracker`
#   all     worker seed pages, in the workflow's order (deploy-pages
#           `needs: deploy-worker`, so a failure stops the rest)
#
# The workflow ran on pushes to main and initial-commit (the default
# branch), so every target refuses unless one of those branches is checked
# out, the tree is clean and HEAD == origin/<branch> (after a fetch).
# Everything runs in a pristine `git archive` export of HEAD (what
# actions/checkout produced), never in the working copy.
#
# Environment (same names as the workflow secrets): CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID. Wrangler reads both from the environment, so they
# never appear on argv and are never echoed or written to disk.

set -euo pipefail

readonly DEPLOY_BRANCHES="main initial-commit"
readonly D1_DATABASE=writer-tracker-db
readonly PAGES_PROJECT=writer-tracker
readonly NODE_MAJOR_EXPECTED=20

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" >&2
  exit "${1:-2}"
}

require_env() {
  local name missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing required environment variable(s): ${missing[*]}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH"
}

# Trigger guard: on.push.branches [main, initial-commit].
guard_synced_with_origin() {
  local remote head
  BRANCH="$(git symbolic-ref --quiet --short HEAD)" \
    || die "HEAD is detached; check out one of: $DEPLOY_BRANCHES"
  case " $DEPLOY_BRANCHES " in
    *" $BRANCH "*) ;;
    *) die "branch '$BRANCH' is not a deploy branch (allowed: $DEPLOY_BRANCHES)" ;;
  esac
  log "checking working tree and origin/$BRANCH"
  git fetch --quiet origin "$BRANCH"
  remote="$(git rev-parse FETCH_HEAD)"
  head="$(git rev-parse HEAD)"
  [ -z "$(git status --porcelain)" ] \
    || die "working tree is not clean; commit or stash first"
  [ "$head" = "$remote" ] \
    || die "HEAD ($head) != origin/$BRANCH ($remote); deploy only what is on GitHub"
  DEPLOY_SHA="$head"
  COMMIT_SUBJECT="$(git log -1 --format=%s "$head")"
  log "deploying $DEPLOY_SHA from $BRANCH"
}

WORK=""
cleanup() { [ -z "$WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT

# Pristine export of HEAD with dependencies installed (`npm install`, as the
# workflow ran it), done once and shared by all targets in this run.
prepare() {
  [ -z "$WORK" ] || return 0
  require_cmd node
  require_cmd npm
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" = "$NODE_MAJOR_EXPECTED" ] \
    || warn "the workflow used Node $NODE_MAJOR_EXPECTED; this machine has Node $(node --version)"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/writent-deploy.XXXXXX")"
  SRC="$WORK/src"
  mkdir "$SRC"
  git archive --format=tar "$DEPLOY_SHA" | tar -x -C "$SRC"
  log "npm install"
  (cd "$SRC" && npm install)
}

run_wrangler() { (cd "$SRC" && npx --no-install wrangler "$@"); }

deploy_worker() {
  prepare
  log "wrangler deploy"
  run_wrangler deploy
}

deploy_seed() {
  prepare
  log "wrangler d1 execute $D1_DATABASE --file=data/seed.sql"
  # CI=true keeps wrangler non-interactive, as it was on the runner.
  CI=true run_wrangler d1 execute "$D1_DATABASE" --file=data/seed.sql
}

deploy_pages() {
  prepare
  log "wrangler pages deploy public --project-name=$PAGES_PROJECT --branch=$BRANCH"
  # The runner had $BRANCH checked out; the export has no .git, so pass the
  # branch and commit explicitly.
  run_wrangler pages deploy public --project-name="$PAGES_PROJECT" \
    --branch="$BRANCH" --commit-hash="$DEPLOY_SHA" --commit-message="$COMMIT_SUBJECT"
}

main() {
  [ "$#" -gt 0 ] || usage
  local targets=() t
  for t in "$@"; do
    case "$t" in
      -h|--help) usage 0 ;;
      all) targets+=(worker seed pages) ;;
      worker|seed|pages) targets+=("$t") ;;
      *) printf 'error: unknown target: %s\n\n' "$t" >&2; usage ;;
    esac
  done
  require_cmd git
  require_env CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  guard_synced_with_origin
  for t in "${targets[@]}"; do
    "deploy_$t"
  done
  log "done: ${targets[*]}"
}

main "$@"
