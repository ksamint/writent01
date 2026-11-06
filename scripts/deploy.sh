#!/usr/bin/env bash
# Local Cloudflare deploy for writer-tracker (writent01), run from the
# operator's machine.
#
# Replaces .github/workflows/deploy.yml (removed 2026-11-05, owner decision:
# no GitHub Actions and no runners).
#
# Usage: scripts/deploy.sh <target> [<target> ...]
#   worker  npm install + `wrangler deploy`: the Worker serves the API
#           (/api, /mcp) and the UI in public/ (Workers static assets).
#   seed    on the remote D1 database: create the schema (the SQL in
#           SCHEMA_SQL in src/db.ts, all CREATE ... IF NOT EXISTS), then load
#           data/seed.sql only if the writers table is empty. Safe to rerun.
#   all     worker seed
#
# The workflow ran on pushes to main and initial-commit (the default
# branch), so every target refuses unless one of those branches is checked
# out, the tree is clean and HEAD == origin/<branch> (after a fetch).
# Everything runs in a pristine `git archive` export of HEAD (what
# actions/checkout produced), never in the working copy.
#
# Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (wrangler reads
# both from the environment, so they never appear on argv and are never
# echoed or written to disk) and CLOUDFLARE_D1_DATABASE_ID (the
# writer-tracker-db UUID from `wrangler d1 list`), which fills the
# wrangler.toml placeholder inside the export only.

set -euo pipefail

readonly DEPLOY_BRANCHES="main initial-commit"
readonly D1_DATABASE=writer-tracker-db
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
  fill_database_id
  log "npm install"
  (cd "$SRC" && npm install)
}

# Fill the wrangler.toml database_id placeholder in the export only.
fill_database_id() {
  local config="$SRC/wrangler.toml"
  [[ "$CLOUDFLARE_D1_DATABASE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || die "CLOUDFLARE_D1_DATABASE_ID is not a D1 database UUID"
  # shellcheck disable=SC2016 # a literal placeholder, not an expansion
  grep -qF 'database_id = "${CLOUDFLARE_D1_DATABASE_ID}"' "$config" \
    || die "wrangler.toml no longer has the database_id placeholder"
  sed -i.bak "s/\\\${CLOUDFLARE_D1_DATABASE_ID}/$CLOUDFLARE_D1_DATABASE_ID/" "$config"
  rm -f "$config.bak"
  # shellcheck disable=SC2016
  ! grep -qF '${' "$config" || die "unfilled placeholder left in wrangler.toml"
}

# The schema is SCHEMA_SQL in src/db.ts (what the Worker's initDB runs),
# extracted so there is one source of truth.
write_schema_sql() {
  node - "$SRC/src/db.ts" "$WORK/schema.sql" <<'NODE'
const fs = require("fs");
const [source, out] = process.argv.slice(2);
const m = fs.readFileSync(source, "utf8")
  .match(/export const SCHEMA_SQL = `([^`]*)`;/);
if (!m) { console.error("error: SCHEMA_SQL not found in src/db.ts"); process.exit(1); }
const sql = m[1].trim();
const tables = (sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;
if (tables < 1 || /\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\b/i.test(sql)) {
  console.error("error: unexpected initDB schema"); process.exit(1); }
fs.writeFileSync(out, sql + "\n");
console.error(`schema: ${tables} tables`);
NODE
}

remote_writer_count() {
  (cd "$SRC" && CI=true npx --no-install wrangler d1 execute "$D1_DATABASE" --remote --json \
    --command "SELECT COUNT(*) AS n FROM writers") \
    | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        // wrangler can print notices (e.g. about proxies) before the JSON.
        const n = JSON.parse(s.slice(s.indexOf("[")))[0].results[0].n;
        if (!Number.isInteger(n)) process.exit(1);
        console.log(n);
      });'
}

run_wrangler() { (cd "$SRC" && npx --no-install wrangler "$@"); }

deploy_worker() {
  prepare
  log "wrangler deploy"
  run_wrangler deploy
}

deploy_seed() {
  prepare
  write_schema_sql
  # CI=true keeps wrangler non-interactive.
  log "wrangler d1 execute $D1_DATABASE --remote --file=<SCHEMA_SQL>"
  CI=true run_wrangler d1 execute "$D1_DATABASE" --remote --file="$WORK/schema.sql"
  local writers
  writers="$(remote_writer_count)" || die "could not count writers in the remote database"
  if [ "$writers" -ne 0 ]; then
    log "seed skipped: the remote database already has $writers writers"
    return 0
  fi
  log "wrangler d1 execute $D1_DATABASE --remote --file=data/seed.sql"
  CI=true run_wrangler d1 execute "$D1_DATABASE" --remote --file=data/seed.sql
}

main() {
  [ "$#" -gt 0 ] || usage
  local targets=() t
  for t in "$@"; do
    case "$t" in
      -h|--help) usage 0 ;;
      all) targets+=(worker seed) ;;
      worker|seed) targets+=("$t") ;;
      pages) die "the pages target is gone: the Worker now serves public/ itself (scripts/deploy.sh worker)" ;;
      *) printf 'error: unknown target: %s\n\n' "$t" >&2; usage ;;
    esac
  done
  require_cmd git
  require_env CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_D1_DATABASE_ID
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  guard_synced_with_origin
  for t in "${targets[@]}"; do
    "deploy_$t"
  done
  log "done: ${targets[*]}"
}

main "$@"
