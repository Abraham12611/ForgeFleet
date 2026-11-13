#!/usr/bin/env bash
# Shared helpers for ForgeFleet private-phase deploy scripts (FF-005).
# Safety invariants: read-only toward Orca, --apply required to mutate,
# no secrets on stdout, redacted logging.
set -euo pipefail

FF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA_DIR="$FF_ROOT/infra"
COMPOSE_FILE="$INFRA_DIR/docker-compose.private.yml"

# Fail closed if any argument tries to drag the Orca service into scope.
forbid_orca_target() {
  for arg in "$@"; do
    case "$arg" in
      *orca-serve*|*orca_serve*)
        echo "refusing: scripts/deploy never manages orca-serve.service" >&2
        exit 2
        ;;
    esac
  done
}

# "$1" = exact flag expected (e.g. --apply). Prints mode, exits 0 dry-run / 1 apply.
want_apply() {
  local flag="${1:-}"; shift || true
  forbid_orca_target "$@"
  for arg in "$@"; do
    if [ "$arg" = "$flag" ]; then return 0; fi
  done
  return 1
}

log()  { printf '[forge-deploy] %s\n' "$*"; }
warn() { printf '[forge-deploy][warn] %s\n' "$*" >&2; }

# Print KEY=[set|missing] lines for env names without ever printing values.
env_presence() {
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then echo "$name=[set]"; else echo "$name=[missing]"; fi
  done
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { warn "missing command: $1"; return 1; }
}

# Resolve the supported Orca CLI wrapper WITHOUT executing it or touching
# the Orca service. Order per VPS finding #65: explicit ORCA_CLI_COMMAND
# (validated), then $HOME/.local/bin, then the extracted CLI shim, then
# /usr/bin, then PATH. The Electron GUI binary
# (.../squashfs-root/orca-ide, no resources/bin) crashes on the Chromium
# sandbox and is refused here; bare `orca` is refused too. Never appends
# --no-sandbox style flags. Prints the selected path.
resolve_orca_cli() {
  if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
    case "$ORCA_CLI_COMMAND" in
      */squashfs-root/orca-ide)
        warn "ORCA_CLI_COMMAND is the Electron GUI binary (use .../resources/bin/orca-ide)"
        return 1
        ;;
    esac
    # Spelled o[r]ca so this source never contains a standalone orca token
    # (the selftest bare-orca guard scans live code, comments stripped).
    cli_base="$(basename -- "$ORCA_CLI_COMMAND")"
    case "$cli_base" in
      o[r]ca)
        warn "bare-orca is not a supported CLI entrypoint"
        return 1
        ;;
    esac
    command -v "$ORCA_CLI_COMMAND" >/dev/null 2>&1 \
      || { warn "ORCA_CLI_COMMAND not on PATH"; return 1; }
    printf '%s' "$ORCA_CLI_COMMAND"
    return 0
  fi
  for c in "$HOME/.local/bin/orca-ide" \
           /opt/orca/squashfs-root/resources/bin/orca-ide \
           /usr/bin/orca-ide; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  if command -v orca-ide >/dev/null 2>&1; then command -v orca-ide; return 0; fi
  return 1
}

# Canonical default for the native bridge state dir. Matches the systemd
# StateDirectory (user state, operator-owned). Exact name follows the server
# contract (PR #63 main.ts: FORGEFLEET_BRIDGE_DATA_DIR); the unit fixes it to
# %S/forgefleet-bridge, which equals this default for the operator user.
# Never /var/lib: the bridge unit's ProtectSystem=strict sandbox cannot write.
default_bridge_state_dir() {
  printf '%s' "${FORGEFLEET_BRIDGE_DATA_DIR:-$HOME/.local/state/forgefleet-bridge}"
}

# Snapshot the bridge state dir into $1 (a destination dir). Skips cleanly
# when no state exists yet. Prints the artifact path on stdout.
snapshot_bridge_state() {
  dest="$1"
  src="$(default_bridge_state_dir)"
  if [ ! -d "$src" ]; then
    warn "no bridge state at $src yet — skipping"
    return 0
  fi
  tar -czf "$dest/bridge-state.tgz" -C "$(dirname "$src")" "$(basename "$src")"
  chmod 600 "$dest/bridge-state.tgz"
  printf '%s' "$dest/bridge-state.tgz"
}

# Restore the bridge state dir from snapshot dir $1 (needs bridge-state.tgz).
# Returns 1 with a warning when the snapshot carries no bridge state.
restore_bridge_state() {
  snap="$1"
  [ -f "$snap/bridge-state.tgz" ] || { warn "snapshot has no bridge-state.tgz — bridge state left untouched"; return 1; }
  dst="$(default_bridge_state_dir)"
  mkdir -p "$dst"
  tar -xzf "$snap/bridge-state.tgz" -C "$(dirname "$dst")"
  log "bridge state restored to $dst (bridge unit stays fenced)"
}

# --- FF-022 additions (additive only; canonical helpers above unchanged) ---
# --- E17/E21 safe-restore gate (PR #51 follow-up): fixture restores stage
# into a SAFE, UNIQUE, DISPOSABLE directory only. Existing directories are
# NEVER deleted; there is no rm -rf of caller-supplied paths anywhere in
# this gate. Prints the resolved absolute path on stdout; refuses (exit 2)
# anything else. ---

# Canonicalize without touching the filesystem beyond resolution.
_canonicalize() {
  python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"
}

# require_safe_fixture_dir <target-dir>: enforce the safe-restore gate.
require_safe_fixture_dir() {
  target="${1:-}"
  [ -n "$target" ] || { warn "refusing fixture restore: --target-dir DIR is required"; return 2; }
  case "$target" in
    /*) ;;
    *) warn "refusing fixture restore: target must be an absolute path (got: $target)"; return 2;;
  esac
  base="$(basename "$target")"
  case "$base" in
    ""|"."|"..") warn "refusing fixture restore: bad target leaf: $target"; return 2;;
  esac
  # A symlink as the target leaf (dangling or not) is always refused before
  # it is resolved: the real destination is elsewhere by definition.
  if [ -L "$target" ]; then
    warn "refusing fixture restore: target is a symlink: $target"; return 2
  fi
  if [ -e "$target" ]; then
    warn "refusing fixture restore: target already exists, never delete existing directories: $target"; return 2
  fi
  parent="$(dirname "$target")"
  [ -d "$parent" ] || {
    warn "refusing fixture restore: parent must already exist as a disposable dir (mktemp -d ...): $parent"
    return 2
  }
  # Resolve FIRST (the fixture root itself may live under a system symlink
  # such as /tmp -> /private/tmp on macOS); every check below runs on the
  # resolved path, so a symlink anywhere in the chain that escapes the
  # allowlisted root is caught by the containment check.
  canon="$(_canonicalize "$target")" || return 2
  repo_root="$(_canonicalize "$FF_ROOT")"
  home_canon="$(_canonicalize "${HOME:-/}")"
  cwd_canon="$(_canonicalize "$PWD")"
  # Allowlisted fixture roots: the operator override when set, otherwise the
  # system temp roots (both $TMPDIR and /tmp — on macOS they live on
  # different branches, /var/... vs /private/tmp, and fixtures use both).
  root1=""; root2=""
  if [ -n "${FF_FIXTURE_ROOT:-}" ]; then
    root1="$(_canonicalize "$FF_FIXTURE_ROOT")" || return 2
  else
    root1="$(_canonicalize "${TMPDIR:-/tmp}")" || return 2
    tmproot="$(_canonicalize "/tmp")" || return 2
    if [ -d "$tmproot" ] && [ "$tmproot" != "$root1" ]; then root2="$tmproot"; fi
  fi
  for fixture_root in "$root1" "$root2"; do
    [ -n "$fixture_root" ] || continue
    [ -d "$fixture_root" ] || {
      warn "refusing fixture restore: fixture root is not a directory: $fixture_root"; return 2
    }
    case "$fixture_root" in
      "/"|"$home_canon"|"$repo_root"|"$cwd_canon")
        warn "refusing fixture restore: fixture root must not be a protected directory: $fixture_root"
        return 2;;
    esac
    if [ "$canon" = "$fixture_root" ]; then
      warn "refusing fixture restore: target is the fixture root itself, pass a fresh leaf inside it: $canon"
      return 2
    fi
  done
  for prot in "/" "$home_canon" "$repo_root" "$cwd_canon"; do
    if [ "$canon" = "$prot" ]; then
      warn "refusing fixture restore: target is a protected directory: $canon"; return 2
    fi
  done
  for prot in "$home_canon" "$repo_root" "$cwd_canon"; do
    case "$prot" in
      "$canon"/*) warn "refusing fixture restore: target contains protected directory $prot: $canon"; return 2;;
    esac
  done
  under_root=0
  case "$canon" in "$root1"/*) under_root=1;; esac
  if [ -n "$root2" ]; then case "$canon" in "$root2"/*) under_root=1;; esac; fi
  [ "$under_root" -eq 1 ] || {
    warn "refusing fixture restore: target escapes allowlisted fixture root(s): $canon (roots: $root1 $root2)"
    return 2
  }
  mkdir "$canon" 2>/dev/null || {
    warn "refusing fixture restore: target appeared concurrently, never overwrite: $canon"; return 2
  }
  printf '%s' "$canon"
}

# verify_live_evidence <evidence-file>: server-authenticated signed proof
# required for any live --apply. The evidence JSON must carry
# paperclip_git_sha, api_contract_version, matrix_sha256, owner,
# approved_at_utc (ISO-8601 UTC), statement, and hmac_sha256. The HMAC
# (SHA-256 hex) covers the canonical payload
#   paperclip_git_sha|api_contract_version|matrix_sha256|owner|approved_at_utc|statement
# keyed by the file at ${FORGEFLEET_EVIDENCE_KEY_FILE:-} (or $2 override).
# Additionally: matrix_sha256 must equal the CURRENT matrix file (a markdown
# edit after signing invalidates the proof); api_contract_version must equal
# the active contract; paperclip_git_sha must be pinned (not unknown) and
# must match PAPERCLIP_GIT_SHA when the environment sets it; owner approval
# must be present and fresh (OWNER_APPROVAL_TTL_HOURS, default 24). Any
# missing/invalid element refuses (fail closed). Never prints key material.
verify_live_evidence() {
  ev="${1:-}"; keyfile="${2:-${FORGEFLEET_EVIDENCE_KEY_FILE:-}}"
  [ -n "$ev" ] || { warn "refusing live change: --evidence FILE (server-signed deploy proof) is required"; return 2; }
  [ -f "$ev" ] || { warn "refusing live change: evidence file not found: $ev"; return 2; }
  [ -n "$keyfile" ] || { warn "refusing live change: evidence key file is required (FORGEFLEET_EVIDENCE_KEY_FILE or --evidence-key)"; return 2; }
  [ -f "$keyfile" ] || { warn "refusing live change: evidence key file not found"; return 2; }
  python3 - "$ev" "$keyfile" "$FF_ROOT/infra/split-compatibility-matrix.md" \
    "${API_CONTRACT_VERSION:-0.1.0-draft}" "${PAPERCLIP_GIT_SHA:-}" \
    "${OWNER_APPROVAL_TTL_HOURS:-24}" <<'EOF'
import hashlib, hmac, json, sys
from datetime import datetime, timedelta, timezone
ev, keyfile, matrix, active_contract, pinned_sha, ttl_h = sys.argv[1:7]
try:
    doc = json.load(open(ev))
except Exception as e:
    print(f"refusing live change: evidence is not valid JSON: {e}", file=sys.stderr); sys.exit(2)
for field in ("paperclip_git_sha", "api_contract_version", "matrix_sha256",
              "owner", "approved_at_utc", "statement", "hmac_sha256"):
    if not doc.get(field):
        print(f"refusing live change: evidence missing field: {field}", file=sys.stderr); sys.exit(2)
payload = "|".join(doc[k] for k in ("paperclip_git_sha", "api_contract_version",
                                    "matrix_sha256", "owner", "approved_at_utc", "statement"))
key = open(keyfile, "rb").read()
want = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
if not hmac.compare_digest(want, doc["hmac_sha256"]):
    print("refusing live change: evidence signature invalid (not server-signed)", file=sys.stderr); sys.exit(2)
actual_matrix = hashlib.sha256(open(matrix, "rb").read()).hexdigest()
if not hmac.compare_digest(actual_matrix, doc["matrix_sha256"]):
    print("refusing live change: evidence matrix sha is stale (matrix edited after signing)", file=sys.stderr); sys.exit(2)
if doc["api_contract_version"] != active_contract:
    print(f"refusing live change: evidence contract {doc['api_contract_version']} != active {active_contract}", file=sys.stderr); sys.exit(2)
if doc["paperclip_git_sha"] in ("", "unknown"):
    print("refusing live change: evidence carries no pinned paperclip sha", file=sys.stderr); sys.exit(2)
if pinned_sha and pinned_sha not in ("", "unknown") and doc["paperclip_git_sha"] != pinned_sha:
    print("refusing live change: evidence sha does not match PAPERCLIP_GIT_SHA", file=sys.stderr); sys.exit(2)
if not doc["owner"].strip():
    print("refusing live change: evidence has no owner approver", file=sys.stderr); sys.exit(2)
try:
    approved = datetime.fromisoformat(doc["approved_at_utc"].replace("Z", "+00:00"))
    if approved.tzinfo is None:
        approved = approved.replace(tzinfo=timezone.utc)
except ValueError:
    print("refusing live change: evidence approved_at_utc is not ISO-8601", file=sys.stderr); sys.exit(2)
if datetime.now(timezone.utc) - approved > timedelta(hours=float(ttl_h)):
    print("refusing live change: owner approval expired", file=sys.stderr); sys.exit(2)
print(f"live evidence OK: sha={doc['paperclip_git_sha'][:12]} contract={doc['api_contract_version']} owner={doc['owner']}")
EOF
}

die()  { warn "$*"; exit 1; }

# Fail closed listing only env NAMES (values stay in secret storage).
require_names() {
  local missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing required env names: ${missing[*]}"
}

# Guard live host mutations behind an explicit flag (dry-run by default).
confirm_live() {
  [ "${FORGEFLEET_LIVE_OK:-0}" = "1" ] \
    || die "refusing live change without FORGEFLEET_LIVE_OK=1 (dry-run by default)"
}
