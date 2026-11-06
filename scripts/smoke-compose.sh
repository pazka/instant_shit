#!/usr/bin/env bash
# Compose-mode smoke (migration safety net, see TESTING.md): runs the BUILT image exactly the way it is
# deployed and proves full capability, not just a 200.
#
#   bash scripts/smoke-compose.sh legacy IMAGE
#     = the box's legacy compose today (/root/hosh-deploy/instantshit): uid 1000, port 80 published on
#       127.0.0.1:12121, cap_drop ALL, no-new-privileges, unprivileged-port sysctl, bind mount ./data:/data.
#
#   bash scripts/smoke-compose.sh template IMAGE
#     = docker-compose.example.yml + .env.example as hosh-deploy runs them (only APP_IMAGE differs): uid 10001,
#       read-only rootfs, tmpfs /tmp, pids 128, mem 512m, PORT=8000 on 127.0.0.1:9136, fresh named volume
#       instantshit-data. Adds: the register validation, healthy healthcheck, /healthz, the POST_DEPLOY
#       command of deploy/hosh-deploy.conf inside the container, a 1 GiB upload/download under the 512m limit.
#
# Checks: production config, Socket.IO notepad edit seen by a 2nd client, upload/download round-trip,
# the data lands in the bind mount (currentFile, meta.json, currentText.json, tmp/), text + file are
# still served after a container restart and after down/up, nothing written outside /data, clean logs.
# Needs docker (compose v2), curl and node (for scripts/capability.js) on the host.
set -euo pipefail

MODE="${1:?usage: smoke-compose.sh legacy|template IMAGE}"
IMAGE="${2:?usage: smoke-compose.sh legacy|template IMAGE}"
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
    USER_WANT=1000:1000
    ;;
  template)
    PORT=9136; CONTAINER=instantshit; PROJECT=instantshit
    cp "$ROOT/docker-compose.example.yml" "$WORK/docker-compose.yml"
    sed "s|^APP_IMAGE=.*|APP_IMAGE='$IMAGE'|" "$ROOT/.env.example" > "$WORK/instantshit.env"
    chmod 600 "$WORK/instantshit.env"
    dk volume inspect instantshit-data >/dev/null 2>&1 && fail "volume instantshit-data already exists here: refusing to touch it"
    USER_WANT=10001:10001
    ;;
  *) fail "unknown mode '$MODE'" ;;
esac
BASE="http://127.0.0.1:${PORT}"
compose() {
  if [ "$MODE" = template ]; then  # as hosh-deploy: the env file serves interpolation and the container
    dk compose -p "$PROJECT" --project-directory "$WORK" --env-file "$WORK/instantshit.env" -f "$WORK/docker-compose.yml" "$@"
  else
    dk compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/docker-compose.yml" "$@"
  fi
}

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

if [ "$MODE" = template ]; then
  step "hosh-deploy register validation"
  bash "$ROOT/scripts/check-hosh-deploy.sh" "$WORK"
fi

step "compose up $IMAGE"
compose up -d --quiet-pull 2>&1 | grep -v -E "^ (Network|Container) " || true
wait_up
[ "$(dk inspect --format '{{.Config.User}}' "$CONTAINER")" = "$USER_WANT" ] || fail "not running as $USER_WANT"

if [ "$MODE" = template ]; then
  step "hardening as configured, healthcheck healthy, /healthz"
  [ "$(dk inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' "$CONTAINER")" = "true 128 536870912" ] \
    || fail "hardening: $(dk inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' "$CONTAINER")"
  for _ in $(seq 1 40); do
    h="$(dk inspect --format '{{.State.Health.Status}}' "$CONTAINER")"; [ "$h" = healthy ] && break; sleep 2
  done
  [ "$h" = healthy ] || fail "healthcheck: $h"
  code 200 "$BASE/healthz"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["status"]=="ok" and d["dataWritable"] is True and d["file"] is None, d' "$WORK/body.out" \
    || fail "healthz: $(cat "$WORK/body.out")"
  code 200 -I "$BASE/healthz"
fi

step "page and production config"
code 200 "$BASE/"
grep -q '/socket.io/socket.io.js' "$WORK/body.out" || fail "page"
code 200 "$BASE/socket.io/socket.io.js"
code 200 "$BASE/title"
[ "$(cat "$WORK/body.out")" = QuickPaste ] || fail "title: $(cat "$WORK/body.out")"
code 200 "$BASE/limits"
[ "$(cat "$WORK/body.out")" = '{"maxFileSize":2147483648,"maxTextSize":100000}' ] || fail "limits: $(cat "$WORK/body.out")"
code 404 "$BASE/file"

if [ "$MODE" = template ]; then
  step "POST_DEPLOY (deploy/hosh-deploy.conf) inside the container"
  read -r -a post <<<"$(sed -n 's/^POST_DEPLOY=//p' "$ROOT/deploy/hosh-deploy.conf")"
  [ "${#post[@]}" -gt 0 ] || fail "POST_DEPLOY empty"
  dk exec "$CONTAINER" "${post[@]}" || fail "POST_DEPLOY"

  step "1 GiB upload + download under mem_limit 512m (streams through /data/tmp, not RAM or the 16m /tmp)"
  head -c 1073741824 /dev/urandom > "$WORK/big.bin"
  code 200 -F "newFile=@$WORK/big.bin" "$BASE/newFile"
  grep -q '"size":1073741824' "$WORK/body.out" || fail "big upload: $(cat "$WORK/body.out")"
  curl -fsS -o "$WORK/big.dl" "$BASE/file"
  cmp -s "$WORK/big.bin" "$WORK/big.dl" || fail "big download differs"
  rm -f "$WORK/big.bin" "$WORK/big.dl"
  [ "$(dk inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' "$CONTAINER")" = "false 0" ] || fail "container OOM-killed or restarted"
  dk stats --no-stream --format 'memory after 1 GiB round-trip: {{.MemUsage}}' "$CONTAINER"
fi

step "notepad over Socket.IO + upload/download round-trip"
node "$ROOT/scripts/capability.js" write "$BASE" "$MARKER" || fail "capability write"

step "data is in the $([ "$MODE" = legacy ] && echo "bind mount" || echo "volume instantshit-data"), owned by uid ${USER_WANT%%:*}"
sleep 3 # the notepad is persisted 2 s after the last edit
src="$([ "$MODE" = legacy ] && echo "$WORK/data" || echo instantshit-data)"
listing="$(dk run --rm --user 0 -v "$src:/data" --entrypoint sh "$IMAGE" -c \
  'cd /data && for f in currentFile meta.json currentText.json tmp; do stat -c "%n %u" "$f"; done; ls -A tmp | wc -l')"
echo "$listing"
[ "$(printf '%s\n' "$listing" | head -n4 | awk '{print $2}' | sort -u)" = "${USER_WANT%%:*}" ] || fail "data files not owned by ${USER_WANT%%:*}"
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

if [ "$MODE" = template ]; then
  code 200 "$BASE/healthz"
  grep -q '"file":{"size":' "$WORK/body.out" || fail "healthz after restore: $(cat "$WORK/body.out")"
fi

step "nothing written outside /data"
changes="$(dk diff "$CONTAINER" | grep -vE ' /data(/|$)' || true)"
[ -z "$changes" ] || { echo "$changes"; fail "container wrote outside /data"; }

step "no errors in logs"
if dk logs "$CONTAINER" 2>&1 | grep -E 'Could not|Error: E[A-Z]+|Uncaught'; then fail "errors in container log"; fi

SMOKE_OK=1
echo "SMOKE OK ($MODE, $IMAGE)"
