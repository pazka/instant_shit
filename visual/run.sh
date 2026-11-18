#!/usr/bin/env bash
# Visual regression of the built image (hosh-management AGENTS.md §3, use cases in TESTING.md
# "Visual use cases"). Pattern of pazka/MyMurderParty visual/ (itself from pazka/plats):
#   visual/run.sh [IMAGE]                (default instantshit:smoke)
# Starts the image hardened as hosh-deploy runs it (uid 10001, read-only rootfs, cap_drop ALL,
# no-new-privileges, PORT=8000, a FRESH empty /data volume, production config of the image) on
# http://localhost:9875 (127.0.0.1), starts two headless Chromes on the runner (mouse / touch) where every other host name
# resolves to nothing, then runs visual/shoot.mjs with the image's own node (built-in fetch + WebSocket, no
# package installed): every use case at 1400 / 1024 / 390, compared with visual/baseline/. Shots, diffs and
# report.json: $OUT.
#   CHROME=/path/to/chrome (default google-chrome)   OUT=visual/out   VISUAL_PRINT_NEW=1 (CI: failing
#   shots printed in the log, visual/from-log.mjs writes them back as files).
# New baselines (QA, in a PR that says the change is wanted): take them from the CI log of the runner's
# Chrome with visual/from-log.mjs, look at every picture, commit them.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
IMAGE="${1:-instantshit:smoke}"
OUT="${OUT:-visual/out}"
NAME="is-visual-$$"
PORT=9875
CDP_DESKTOP=9351
CDP_PHONE=9352
P1="$(mktemp -d)"; P2="$(mktemp -d)"
PIDS=()
dk() { MSYS_NO_PATHCONV=1 docker "$@"; }
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  dk rm -f "$NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$NAME-data" >/dev/null 2>&1 || true
  rm -rf "$P1" "$P2"
}
trap cleanup EXIT

# the shared paste and file live in /data: a fresh volume = the empty page of use case E1
dk volume create "$NAME-data" >/dev/null
dk run -d --name "$NAME" \
  --user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e PORT=8000 -v "$NAME-data:/data" -p "127.0.0.1:$PORT:8000" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { dk logs "$NAME" | tail -40; exit 1; }
test "$(dk exec "$NAME" id -u)" = 10001

RULES="MAP localhost 127.0.0.1, MAP * ~NOTFOUND"  # = visual/cdp.mjs RESOLVER_RULES
COMMON=(--headless=new --no-sandbox --disable-gpu --mute-audio --no-first-run --hide-scrollbars
  --force-color-profile=srgb --font-render-hinting=none --disable-features=Translate,MediaRouter
  --disable-background-networking "--host-resolver-rules=$RULES")
"${CHROME:-google-chrome}" "${COMMON[@]}" \
  --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 \
  --remote-debugging-port=$CDP_DESKTOP --user-data-dir="$P1" about:blank >/dev/null 2>&1 &
PIDS+=($!)
"${CHROME:-google-chrome}" "${COMMON[@]}" \
  --remote-debugging-port=$CDP_PHONE --user-data-dir="$P2" about:blank >/dev/null 2>&1 &
PIDS+=($!)

rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$OUT"
set +e
dk run --rm --network host --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e CDP_DESKTOP=$CDP_DESKTOP -e CDP_PHONE=$CDP_PHONE -e OUT=/out -e BASELINE=/v/baseline/ \
  -e VISUAL_PRINT_NEW="${VISUAL_PRINT_NEW:-}" \
  -v "$ROOT/visual:/v:ro" -v "$ROOT/$OUT:/out" --entrypoint node "$IMAGE" \
  /v/shoot.mjs "http://localhost:$PORT" "$@"
rc=$?
set -e
dk logs "$NAME" 2>&1 | grep -qiE 'unhandled|TypeError|ReferenceError|Upload failed' && { echo "VISUAL FAIL: server logged an error" >&2; rc=1; }
exit $rc
