#!/usr/bin/env bash
# Compose-mode smoke (migration safety net, see TESTING.md): runs the BUILT image exactly the way it is
# deployed and proves full capability, not just a 200.
#
#   bash scripts/smoke-compose.sh legacy IMAGE
#     = the box's legacy compose today (/root/hosh-deploy/instantshit): uid 1000, port 80 published on
#       127.0.0.1:12121, cap_drop ALL, no-new-privileges, unprivileged-port sysctl, bind mount ./data:/data.
#
# Checks: production config, Socket.IO notepad edit seen by a 2nd client, upload/download round-trip,
# the data lands in the bind mount (currentFile, meta.json, currentText.json, tmp/), text + file are
# still served after a container restart and after down/up, nothing written outside /data, clean logs.
# Needs docker (compose v2), curl and node (for scripts/capability.js) on the host.
set -euo pipefail

MODE="${1:?usage: smoke-compose.sh legacy IMAGE}"
IMAGE="${2:?usage: smoke-compose.sh legacy IMAGE}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
MARKER="smoke-$$-$RANDOM"
export SMOKE_IMAGE="$IMAGE"

dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
fail() { echo "SMOKE FAIL ($MODE): $*" >&2; exit 1; }
step() { echo "== [$MODE] $*"; }
code() { # code <expected> <curl args...>   body saved to $WORK/body.out
  local want="$1"; shift
  local got
  got="$(curl -sS -o "$WORK/body.out" -w '%{http_code}' "$@")"
  [ "$got" = "$want" ] || { head -c 300 "$WORK/body.out" >&2; echo >&2; fail "expected $want got $got for: $*"; }
}

case "$MODE" in
  legacy)
    PORT=12121; CONTAINER=instantshit; PROJECT=instantshit-legacy-smoke
    mkdir "$WORK/data"
    # the box's legacy compose, verbatim except the image (and an explicit project name)
    cat >"$WORK/docker-compose.yml" <<'YML'
services:
  instant_shit:
    container_name: instantshit
    image: ${SMOKE_IMAGE}
    ports: ["127.0.0.1:12121:80"]
    user: "1000:1000"
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    sysctls: [net.ipv4.ip_unprivileged_port_start=0]
    restart: unless-stopped
    volumes: [./data:/data]
YML
    # on the box ./data belongs to uid 1000
    dk run --rm --user 0 -v "$WORK/data:/data" --entrypoint sh "$IMAGE" -c 'chown 1000:1000 /data'
    ;;
  *) fail "unknown mode '$MODE'" ;;
esac
BASE="http://127.0.0.1:${PORT}"
compose() { dk compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/docker-compose.yml" "$@"; }

cleanup() {
  if [ "${SMOKE_OK:-0}" != 1 ]; then echo "---- container log ----"; dk logs "$CONTAINER" 2>&1 | tail -n 40 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -d "$WORK/data" ]; then  # files written by uid 1000: remove them from inside a container
    dk run --rm --user 0 -v "$WORK/data:/data" --entrypoint sh "$IMAGE" -c 'rm -rf /data/* /data/.[!.]*' >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$BASE/title" 2>/dev/null && return 0
    [ "$(dk inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] || { sleep 1; continue; }
    sleep 1
  done
  fail "not listening on $BASE after 60s"
}

step "compose up $IMAGE"
compose up -d --quiet-pull 2>&1 | grep -v -E "^ (Network|Container) " || true
wait_up
[ "$(dk inspect --format '{{.Config.User}}' "$CONTAINER")" = "1000:1000" ] || fail "not running as 1000:1000"

step "page and production config"
code 200 "$BASE/"
grep -q '/socket.io/socket.io.js' "$WORK/body.out" || fail "page"
code 200 "$BASE/socket.io/socket.io.js"
code 200 "$BASE/title"
[ "$(cat "$WORK/body.out")" = QuickPaste ] || fail "title: $(cat "$WORK/body.out")"
code 200 "$BASE/limits"
[ "$(cat "$WORK/body.out")" = '{"maxFileSize":2147483648,"maxTextSize":100000}' ] || fail "limits: $(cat "$WORK/body.out")"
code 404 "$BASE/file"

step "notepad over Socket.IO + upload/download round-trip"
node "$ROOT/scripts/capability.js" write "$BASE" "$MARKER" || fail "capability write"

step "data is in the bind mount, owned by uid 1000"
sleep 3 # the notepad is persisted 2 s after the last edit
listing="$(dk run --rm --user 0 -v "$WORK/data:/data" --entrypoint sh "$IMAGE" -c \
  'cd /data && for f in currentFile meta.json currentText.json tmp; do stat -c "%n %u" "$f"; done; ls -A tmp | wc -l')"
echo "$listing"
[ "$(printf '%s\n' "$listing" | head -n4 | awk '{print $2}' | sort -u)" = 1000 ] || fail "data files not owned by 1000"
[ "$(printf '%s\n' "$listing" | tail -n1)" = 0 ] || fail "upload temp files left in data/tmp"

step "restart keeps text and file"
compose restart >/dev/null 2>&1
wait_up
node "$ROOT/scripts/capability.js" verify "$BASE" "$MARKER" || fail "lost after restart"

step "down/up (new container, same data) keeps text and file"
compose down >/dev/null 2>&1
compose up -d >/dev/null 2>&1
wait_up
node "$ROOT/scripts/capability.js" verify "$BASE" "$MARKER" || fail "lost after down/up"

step "nothing written outside /data"
changes="$(dk diff "$CONTAINER" | grep -vE ' /data(/|$)' || true)"
[ -z "$changes" ] || { echo "$changes"; fail "container wrote outside /data"; }

step "no errors in logs"
if dk logs "$CONTAINER" 2>&1 | grep -E 'Could not|Error: E[A-Z]+|Uncaught'; then fail "errors in container log"; fi

SMOKE_OK=1
echo "SMOKE OK ($MODE, $IMAGE)"
