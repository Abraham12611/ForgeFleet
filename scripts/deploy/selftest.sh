#!/usr/bin/env bash
# Scaffold selftest for FF-005 (fixture-only, no Docker/secrets/VPS).
# Validates shape + isolation guards. This is NOT integration evidence.
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "PASS: $1"; }
bad()  { failed=$((failed+1)); echo "FAIL: $1" >&2; }

D="$FF_ROOT/scripts/deploy"
I="$FF_ROOT/infra"
# Operator scripts under test: the selftest harness itself is excluded, and
# all checks below scan code with trailing comments stripped, so prose that
# names a forbidden thing cannot trip its own guard.
OPS="$(find "$D" -name '*.sh' -not -name 'selftest.sh' | sort)"
no_comments() { sed 's/#.*//'; }

# 1. All scripts parse.
for f in "$D"/*.sh "$D"/lib/*.sh; do
  bash -n "$f" && ok "bash -n $(basename "$f")" || bad "bash -n $(basename "$f")"
done

# 2. Compose: isolated, loopback-only, pinned, secret-free.
no_comments < "$I/docker-compose.private.yml" | grep -q 'orca-serve' \
  && bad "compose references orca-serve" || ok "compose has no orca-serve reference"
grep -E '^\s+-\s+"' "$I/docker-compose.private.yml" | grep -v '127.0.0.1' \
  && bad "compose publishes a non-loopback port" || ok "compose ports are loopback-only"
grep -A3 'db:' "$I/docker-compose.private.yml" | grep -q 'ports:' \
  && bad "db publishes ports" || ok "db has no published ports"
grep -q 'image: "${[A-Z_]*:?' "$I/docker-compose.private.yml" \
  && ok "compose images fail closed on unset pins" || bad "compose images not pin-guarded"
grep -qiE 'password=|passwd|secret=.+[^:?}]|BEGIN .*PRIVATE KEY' "$I/docker-compose.private.yml" \
  && bad "compose contains secret-looking value" || ok "compose carries no secrets"

# 3. Env examples: names only, no real credentials.
grep -rqiE 'BEGIN .*PRIVATE KEY|ghp_|github_pat_|sk-[A-Za-z0-9]{8}' "$I"/*.env.example \
  && bad "env.example contains credential-looking value" || ok "env.examples are credential-free"
grep -q 'BRIDGE_BIND=127.0.0.1' "$I/bridge.env.example" \
  && ok "bridge default bind is loopback" || bad "bridge default bind drifted"

# 4. Systemd: hardened, guarded, never bound to Orca.
for u in "$I"/systemd/*.service; do
  grep -q 'NoNewPrivileges=true' "$u" && grep -q 'PrivateTmp=true' "$u" \
    && ok "$(basename "$u") hardened" || bad "$(basename "$u") missing hardening"
  no_comments < "$u" | grep -qE 'orca-serve|systemctl.*(restart|stop|start).*orca' \
    && bad "$(basename "$u") manages Orca" || ok "$(basename "$u") never manages Orca"
done
grep -q 'guard-loopback' "$I/systemd/forgefleet-bridge.service" \
  && ok "bridge unit runs loopback guard" || bad "bridge unit missing loopback guard"

# 5. Loopback guard behavior (both outcomes).
BRIDGE_BIND=127.0.0.1:8787 "$D/guard-loopback.sh" >/dev/null \
  && ok "guard accepts loopback" || bad "guard rejects loopback"
BRIDGE_BIND=0.0.0.0:8787 "$D/guard-loopback.sh" >/dev/null 2>&1 \
  && bad "guard accepts 0.0.0.0" || ok "guard refuses non-loopback"

# 6. Deploy scripts fail closed without pins/secrets (dry-run default).
if PAPERCLIP_IMAGE=x BRIDGE_IMAGE=x POSTGRES_IMAGE=x "$D/deploy-private.sh" >/dev/null 2>&1; then
  bad "deploy succeeded without secret files"
else
  ok "deploy refuses without secret files"
fi
"$D/restore.sh" >/dev/null 2>&1 \
  && bad "restore runs without snapshot/guard" || ok "restore refuses without snapshot+fence"

# 7. No operator script issues a bare `orca` or a mutating systemctl verb.
#    (Read-only `systemctl --user status/show orca-serve` in preflight is allowed.)
if no_comments $OPS | grep -E '(^|[^a-zA-Z_/-])orca([^-a-zA-Z_.]|$)' \
     | grep -vE 'orca-serve|orca-ide|orca-bridge|ORCA_' | grep -q .; then
  bad "bare orca invocation found in scripts/deploy"
else
  ok "no bare orca invocation in scripts/deploy"
fi
if no_comments $OPS | grep -E 'systemctl.*(restart|stop|start|disable|mask)' | grep -q .; then
  bad "mutating systemctl verb found in scripts/deploy"
else
  ok "no mutating systemctl verb in scripts/deploy"
fi

# 8. Every mutating script defaults to dry-run (requires explicit --apply).
for s in deploy-private backup restore rollback-private; do
  grep -q -- '--apply' "$D/$s.sh" && ok "$s.sh gates mutation behind --apply" \
    || bad "$s.sh has no --apply gate"
done

echo "---"
echo "selftest: $pass passed, $failed failed (fixture-only, not integration evidence)"
[ "$failed" -eq 0 ]
