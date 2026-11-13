#!/usr/bin/env bash
# Disposable proof that the private-phase preflight (FF-005) treats the
# Node >=24 server floor as a hard failure (PR #63: server entrypoint is
# `node src/main.ts` with type-stripping). Builds a fake PATH (systemctl,
# node, free, df, tailscale, docker) so nothing is observed or executed;
# asserts Node 22 fails closed and Node 24 passes.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")/../" && pwd)/lib/common.sh"

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-preflight-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/fakebin"

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "proof-ok: $1"; }
bad()  { failed=$((failed+1)); echo "proof-FAIL: $1" >&2; }

# systemctl: status fails (unit not observable, warn-only); show succeeds
# with empty output — the preflight must never print unit metadata values,
# so emptiness is the correct fixture behavior.
cat > "$work/fakebin/systemctl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "status" ] && exit 1; done
exit 0
EOF
# node: version floor driven by FAKE_NODE_MAJOR for the case under test.
cat > "$work/fakebin/node" <<'EOF'
#!/usr/bin/env bash
major="${FAKE_NODE_MAJOR:-0}"
if [ "${1:-}" = "-p" ]; then printf '%s' "$major"; else printf 'v%s.0.0' "$major"; fi
EOF
# Host inventory + admin connectivity stubs (canned, value-free).
printf '#!/usr/bin/env bash\necho "Mem: 1 2 3"\n' > "$work/fakebin/free"
printf '#!/usr/bin/env bash\necho "Filesystem Size Used"\n' > "$work/fakebin/df"
printf '#!/usr/bin/env bash\necho "fake tailnet"\n' > "$work/fakebin/tailscale"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/fakebin/docker"
# Explicit CLI selection so resolution never depends on the host.
printf '#!/usr/bin/env bash\necho fake\n' > "$work/fakebin/custom-ide"
chmod +x "$work/fakebin"/*

run_preflight() {
  PATH="$work/fakebin:/usr/bin:/bin" \
  ORCA_CLI_COMMAND="custom-ide" \
  PAPERCLIP_IMAGE=x POSTGRES_IMAGE=x \
  FAKE_NODE_MAJOR="$1" \
  bash "$FF_ROOT/scripts/deploy/provision-private.sh" >/dev/null 2>&1
}

# Node 22 (below the >=24 server floor) must fail closed.
if run_preflight 22; then
  bad "preflight passed with Node 22 (floor must be a hard failure)"
else
  ok "preflight refuses Node 22"
fi

# Node 24 (the floor) must pass the version gate.
if run_preflight 24; then
  ok "preflight accepts Node 24"
else
  bad "preflight refused Node 24"
fi

echo "proof: $pass passed, $failed failed"
[ "$failed" -eq 0 ]
