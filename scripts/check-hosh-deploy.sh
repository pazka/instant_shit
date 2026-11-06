#!/usr/bin/env bash
# check-hosh-deploy.sh [DIR] — what `hosh-deploy register instantshit` validates on the box, run in CI so a
# release can't fail registration (box: hosh-migration/scripts/hosh-deploy do_register; the python part is
# copied verbatim). DIR = a checkout with docker-compose.yml (default: a temp copy of docker-compose.example.yml)
# and instantshit.env (default: .env.example).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "✗ $*" >&2; exit 1; }
declare -A C
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] && C[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
done < "$ROOT/deploy/hosh-deploy.conf"
for k in SERVICE IMAGE_VAR IMAGE_REPO ENV_FILE HOST BIND HEALTH; do [ -n "${C[$k]:-}" ] || die "$k missing in deploy/hosh-deploy.conf"; done
[[ "${C[IMAGE_REPO]}" =~ ^ghcr\.io/pazka/[a-z0-9._-]+$ ]] || die "IMAGE_REPO must be ghcr.io/pazka/<name>"
[[ "${C[BIND]}" =~ ^127\.0\.0\.1:[0-9]{2,5}$ ]] || die "BIND must be 127.0.0.1:<port>"
[[ "${C[HOST]}" =~ ^[a-z0-9.-]+$ ]] && [[ "${C[HEALTH]}" =~ ^/[A-Za-z0-9/_.-]*$ ]] && [[ "${C[IMAGE_VAR]}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "bad HOST/HEALTH/IMAGE_VAR"
grep -q "Host(\`\(@@HOST@@\|__HOST__\)\`)" "$ROOT/deploy/traefik-route.yml.tmpl" || die "route template has no Host(@@HOST@@) rule"
grep -q "^${C[IMAGE_VAR]}=" "$ROOT/.env.example" || die "${C[IMAGE_VAR]} not in .env.example"

dir="${1:-}"
if [ -z "$dir" ]; then
  dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
  cp "$ROOT/docker-compose.example.yml" "$dir/docker-compose.yml"
  install -m 600 "$ROOT/.env.example" "$dir/${C[ENV_FILE]}"
fi
req="$(sed -n 's/^# required:[[:space:]]*//p' "$ROOT/.env.example" | head -n1)"
for k in $req; do
  [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || die ".env.example # required: bad name '$k'"
done
echo "-- compose hardening check (as hosh-deploy register)"
docker compose --project-directory "$dir" --env-file "$dir/${C[ENV_FILE]}" -f "$dir/docker-compose.yml" config --format json \
    | python3 -c '
import json, sys
svc, bind = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin); bad = []
if svc not in d.get("services", {}): bad.append("service %s not in compose" % svc)
for name, s in d.get("services", {}).items():
    p = name + ": "
    u = str(s.get("user", "")).split(":")[0]
    if u in ("", "0", "root"): bad.append(p + "user must be non-root")
    if not s.get("read_only"): bad.append(p + "read_only: true required")
    if "ALL" not in (s.get("cap_drop") or []): bad.append(p + "cap_drop: [ALL] required")
    if s.get("cap_add"): bad.append(p + "cap_add not allowed")
    if not any(o.replace(" ", "") in ("no-new-privileges:true", "no-new-privileges") for o in (s.get("security_opt") or [])): bad.append(p + "no-new-privileges required")
    if s.get("privileged"): bad.append(p + "privileged not allowed")
    for k in ("network_mode", "pid", "ipc", "userns_mode", "uts"):
        if str(s.get(k, "")).startswith("host"): bad.append(p + k + ": host not allowed")
    if s.get("devices"): bad.append(p + "devices not allowed")
    for v in s.get("volumes") or []:
        if v.get("type") not in ("volume", "tmpfs"): bad.append(p + "only named volumes/tmpfs (got %s %s)" % (v.get("type"), v.get("source")))
    for pt in s.get("ports") or []:
        if pt.get("host_ip") not in ("127.0.0.1", "::1"): bad.append(p + "ports must bind 127.0.0.1")
        elif "%s:%s" % (pt.get("host_ip"), pt.get("published")) != bind: bad.append(p + "published %s:%s != BIND %s" % (pt.get("host_ip"), pt.get("published"), bind))
    if not s.get("healthcheck") or s["healthcheck"].get("disable"): bad.append(p + "healthcheck required")
print("\n".join("  ✗ " + b for b in bad) if bad else "  ✓ hardened (non-root, read-only, cap_drop ALL, no-new-privileges, no host access, loopback port, healthcheck)")
sys.exit(1 if bad else 0)' "${C[SERVICE]}" "${C[BIND]}" || die "compose does not meet the box standard (11-BOX-STANDARD.md §2)"
echo "✓ hosh-deploy register checks pass (${C[SERVICE]}, ${C[HOST]}, ${C[BIND]})"
