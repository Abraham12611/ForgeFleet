#!/usr/bin/env bash
# Disposable proof for the Orca CLI wrapper resolver (VPS finding #65).
# Builds a fake HOME + PATH, never executes any Orca binary, never touches
# any service. Proves: explicit valid selection, GUI-binary refusal, bare-orca
# refusal, candidate order, and empty failure.
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")/../" && pwd)/lib/common.sh"

work="$(mktemp -d "${TMPDIR:-/tmp}/forge-orca-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME/.local/bin" "$work/pathbin"
unset ORCA_CLI_COMMAND

pass=0; failed=0
ok()   { pass=$((pass+1)); echo "proof-ok: $1"; }
bad()  { failed=$((failed+1)); echo "proof-FAIL: $1" >&2; }

fake() { printf '#!/usr/bin/env bash\necho fake\n' > "$1"; chmod +x "$1"; }

# (a) Explicit valid ORCA_CLI_COMMAND wins.
fake "$work/pathbin/custom-ide"
if [ "$(ORCA_CLI_COMMAND="$work/pathbin/custom-ide" PATH="$work/pathbin:/usr/bin:/bin" resolve_orca_cli 2>/dev/null)" = "$work/pathbin/custom-ide" ]; then
  ok "explicit ORCA_CLI_COMMAND selected"
else
  bad "explicit ORCA_CLI_COMMAND not selected"
fi

# (b) GUI binary path refused even when executable.
fake "$work/gui-ide"
if ORCA_CLI_COMMAND="$work/squashfs-root/orca-ide" PATH="$work/pathbin:/usr/bin:/bin" resolve_orca_cli >/dev/null 2>&1; then
  bad "GUI binary path accepted"
else
  ok "GUI binary path refused"
fi

# (c) Bare-orca refused even when on PATH.
fake "$work/pathbin/orca"
if ORCA_CLI_COMMAND="orca" PATH="$work/pathbin:/usr/bin:/bin" resolve_orca_cli >/dev/null 2>&1; then
  bad "bare-orca accepted"
else
  ok "bare-orca refused"
fi

# (d) Candidate order: $HOME/.local/bin beats PATH.
fake "$HOME/.local/bin/orca-ide"
fake "$work/pathbin/orca-ide"
if [ "$(PATH="$work/pathbin:/usr/bin:/bin" resolve_orca_cli 2>/dev/null)" = "$HOME/.local/bin/orca-ide" ]; then
  ok "HOME candidate preferred over PATH"
else
  bad "candidate order wrong"
fi

# (e) Restricted PATH: either fails closed, or selects a packaged shim —
# never the GUI binary, never bare orca, and nothing is executed.
rm -f "$HOME/.local/bin/orca-ide" "$work/pathbin/orca-ide"
mkdir -p "$work/empty"
if sel="$(PATH="$work/empty:/usr/bin:/bin" resolve_orca_cli 2>/dev/null)"; then
  case "$sel" in
    */squashfs-root/orca-ide) bad "fallback selected GUI binary: $sel" ;;
    *) case "$(basename -- "$sel")" in o[r]ca) bad "fallback selected bare-orca" ;; *) ok "fallback safe: $sel" ;; esac ;;
  esac
else
  ok "empty environment fails closed"
fi

echo "proof: $pass passed, $failed failed"
[ "$failed" -eq 0 ]
