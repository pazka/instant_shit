#!/usr/bin/env bash
# Container smoke test (upgrade safety net, see TESTING.md).
# Runs the BUILT image hardened (uid 1000, read-only rootfs, cap_drop ALL, no-new-privileges) with a /data
# volume like docker-compose.yml, checks the page, the production config, an upload/download round-trip,
# the Socket.IO handshake, and that the file survives a container restart.
#
#   docker build -t instantshit:smoke . && bash scripts/smoke.sh instantshit:smoke
set -euo pipefail

IMAGE="${1:-instantshit:smoke}"
NAME="instantshit-smoke-$$"
PORT="${SMOKE_PORT:-18121}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
cd "$TMP" # fixtures are referenced by relative name (portable curl -F)

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }  # Git Bash on Windows rewrites /paths in args
cleanup() {
  cd /
  if [ "${SMOKE_OK:-0}" != 1 ]; then echo "---- container log ----"; dk logs "$NAME" 2>&1 | tail -n 40 || true; fi
  dk rm -f "$NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$NAME-data" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }
code() { # code <expected> <curl args...>   body saved to body.out
  local want="$1"; shift
  local got
  got="$(curl -sS -o body.out -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || { head -c 300 body.out >&2; echo >&2; fail "expected $want got $got for: $*"; }
}
wait_up() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$BASE/title" 2>/dev/null && return 0
    [ "$(dk inspect --format '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
    sleep 1
  done
  fail "not listening after 60s"
}

step "start $IMAGE (uid 1000, read-only rootfs, cap_drop ALL, no-new-privileges, /data volume)"
dk run --rm -v "$NAME-data:/data" --entrypoint sh "$IMAGE" -c 'chown 1000:1000 /data'
dk run -d --name "$NAME" --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v "$NAME-data:/data" -p "127.0.0.1:${PORT}:80" "$IMAGE" >/dev/null
wait_up

step "page and production config"
code 200 "$BASE/"
grep -q '/socket.io/socket.io.js' body.out || fail "page"
code 200 "$BASE/socket.io/socket.io.js"
code 200 "$BASE/title"
[ "$(cat body.out)" = QuickPaste ] || fail "title: $(cat body.out)"
code 200 "$BASE/limits"
[ "$(cat body.out)" = '{"maxFileSize":2147483648,"maxTextSize":100000}' ] || fail "limits: $(cat body.out)"
code 404 "$BASE/file"

step "Socket.IO handshake"
code 200 "$BASE/socket.io/?EIO=4&transport=polling"
grep -q '"sid"' body.out || fail "no engine.io sid"

step "upload / download"
echo "smoke paste $$" >paste.txt
code 200 -F "newFile=@paste.txt" "$BASE/newFile"
grep -q '"status":true' body.out || fail "upload: $(cat body.out)"
code 200 "$BASE/file"
cmp -s body.out paste.txt || fail "downloaded file differs"

step "restart keeps the file"
dk restart "$NAME" >/dev/null
wait_up
code 200 "$BASE/file"
cmp -s body.out paste.txt || fail "file lost on restart"

step "no errors in logs"
if dk logs "$NAME" 2>&1 | grep -E 'Could not|Error: E[A-Z]+|Uncaught'; then fail "errors in container log"; fi

SMOKE_OK=1
echo "SMOKE OK ($IMAGE)"
