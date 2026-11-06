# Deploying pad.hosh.it (instantshit)

Deployment on the hosh.it box (box standard: `docs/BOX-CONTRACT.md`). After the cutover (§6), releases
deploy themselves through **hosh-deploy** (§1). Until then the box runs the **legacy compose** (§5), which
keeps working unchanged with every new image. `.env.example` defaults already fit the box; there is no secret.

## 1. How releases go live (hosh-deploy — the only deploy path once cut over)

Every final release (tag `vX.Y.Z` → `release` workflow) ends with the **`deploy`** job: GitHub connects to
the box as `deployer` with this repo's `HOSH_DEPLOY_KEY` (bound to instantshit only) and runs
`hosh-deploy deploy instantshit vX.Y.Z`. The box pulls the image, swaps the tag in `instantshit.env`, waits
healthy, checks `/healthz` on the loopback port and through Traefik, runs `POST_DEPLOY` inside the container
(`deploy/hosh-deploy.conf`, read-only checks) and **rolls back by itself** if any check fails (the workflow
then goes red). Nothing from the repo runs on the host.

- No `HOSH_DEPLOY_KEY` secret (before the cutover): the deploy job prints a notice and does nothing, so a
  release only pushes `:vX.Y.Z`, `:<sha>` and `:latest` exactly as before. Prerelease tags (`v1.2.3-rc.1`)
  and branch builds are never deployed and never move `:latest`.
- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box (owner, or the on-box Claude without a sudo window): `sudo hosh-deploy deploy instantshit vX.Y.Z`,
  `sudo hosh-deploy rollback instantshit`, `sudo hosh-deploy status instantshit`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 2. Variables (`instantshit.env`, mode 600, one file for compose interpolation and the container)

| Variable | Box value | Who | Meaning |
|---|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/instantshit:vX.Y.Z` | hosh-deploy | the only line hosh-deploy rewrites |
| `APP_BIND` | `127.0.0.1:9136` | fixed | loopback publish (port registry) |
| `PORT` | `8000` | fixed | container port (image default `80` = legacy compose) |
| `DATA_DIR` | `/data` | fixed | all state; the `instantshit-data` volume (image default `/data`) |
| `TITLE` | `QuickPaste` | owner (optional) | page title (`GET /title`); copy from the legacy `.env` if it sets one |

Fixed in the image (`config.prod.json`): max upload 2 GiB, max notepad 100 000 chars, CORS `*`.
No secret, no `# required:` name: the pad has no login by design.

## 3. Capability checks (what "works" means — not just a 200)

Read-only (safe on the live pad; `POST_DEPLOY` = `node /checks/postdeploy.js http://127.0.0.1:8000` runs these):
- `GET /healthz` → 200 `{"status":"ok","dataWritable":true,"file":{size,time}|null,"text":{time,saved},…}`
  (a probe file is written, read back and deleted in `/data`; `/data/tmp` writable). 503 + `"status":"error"` otherwise.
- `GET /` → 200 HTML containing `/socket.io/socket.io.js`; `GET /socket.io/socket.io.js` → 200.
- `GET /title` → `QuickPaste`; `GET /limits` → `{"maxFileSize":2147483648,"maxTextSize":100000}`.
- `GET /all` → `{"txt":{"time","val"},"file":{"time","val","size"}}` — after the cutover: same `file.val`/`file.size`
  and same text as `GET /all` on the legacy instance just before (data moved).
- Socket.IO: `GET /socket.io/?EIO=4&transport=polling` → `0{"sid":…}`; POST `40` → `ok`; GET → `40{…}` + `42["my-id",…]`.
- `GET /file` → 200 with `Content-Disposition: attachment; filename="<name>"` and the same bytes as before
  (sha256 of `currentFile` in the volume), or 404 JSON when no file was ever uploaded.

Write round-trip (CI only, `scripts/smoke-compose.sh`; on the box only if the owner accepts replacing the pad):
notepad edit seen by a second Socket.IO client, upload → `new_file` broadcast → download identical, both still
served after `docker restart` and after `compose down`/`up`; a 1 GiB upload/download under the compose `mem_limit`.

## 4. What runs

| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/instantshit:vX.Y.Z` (node 26 alpine, `scripts/check-node-version.sh` gate before any push) |
| Upstream | container :8000 → `127.0.0.1:9136` |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/instantshit.yml` (router `instantshit@file`, resolver `le`, HSTS) |
| Volume | docker volume `instantshit-data` → `/data` (in the monthly restic golden backup) |
| Health | `GET /healthz` → `{"status":"ok", …}`; image `HEALTHCHECK` uses node's `fetch` (no curl) |
| Hardening | uid 10001, read-only rootfs, tmpfs `/tmp` 16m (unused), cap_drop ALL, no-new-privileges, pids 128, mem 3g (see §5) |
| Outbound | none (the server makes no outbound call; the page loads only its own assets) |

## 5. Decisions / known limits

- **Backward compatible image.** Defaults `PORT=80`, `DATA_DIR=/data`, `/data` owned by 10001 with mode 1777
  (an empty named volume takes the image's owner/mode on every mount, so any non-root uid can start on a fresh
  volume). The legacy compose (uid 1000, `./data:/data` bind mount, `127.0.0.1:12121:80`) keeps working
  unchanged; CI proves both modes on every PR and before every release push (`scripts/smoke-compose.sh legacy|template`).
- **Uploads up to 2 GiB go to disk, not the tmpfs**: express-fileupload writes to `/data/tmp` (same volume), then
  the file is *renamed* to `/data/currentFile` (no copy); the 16m `/tmp` tmpfs is never used. But express-fileupload
  1.5 writes **without backpressure**: when the client sends faster than the disk writes, the unwritten part of the
  upload waits in RAM. Usually ~35 MiB after, but under 512m a 1 GiB CI upload once lost its connection mid-upload (most likely OOM;
  the container state was not captured then, the smoke now reports it; passed on re-run). Hence **`mem_limit 3g`** (raised from the box default 512m: one fully buffered 2 GiB upload +
  node; the legacy compose has no limit at all; the box has 15 GiB) and **`pids_limit 128`** (one node process,
  ~12 threads). Several simultaneous multi-GiB uploads from fast clients could still exceed it (OOM kill → restart,
  the upload fails, stored data is safe). The volume needs free space for 2 × the largest upload.
- `X-Forwarded-For`: `trust proxy 1` (one hop, as before) — behind Traefik → docker-proxy that hop is the edge.
  Rate limits (15 uploads / 10 min, 30 downloads / min per IP) are deliberate.
- No authentication by design: anyone with the URL can read and replace the text and the file.
- Logs: morgan `combined` lines on stdout (raw client IPs, as before); `/healthz` is not logged.
- Image runs as root if no `user:` is given (unchanged); both composes set a non-root user.

## 6. Cutover from legacy (on-box coordinator; owner where marked)

Box rules: `ACTIONS-LOG.md` intent BEFORE + result/REVERT AFTER, `/home/pazka/MIGRATION/scripts/smoke.sh`
BEFORE and AFTER, root only in an owner-opened sudo window (`sudo claude-grant`). Downtime: from step 4 to
the end of step 6 (a few minutes).

**0. Prerequisites**
- A final release `vX.Y.Z` that contains this file (first one after the migration PR; `v0.1.1` does NOT have
  `/healthz` and would be rolled back). Below: `V=vX.Y.Z`.
- **Owner: make the GHCR package `instantshit` public** (it is private today, X.28): hosh-deploy pulls
  anonymously. Check from the box: `docker pull ghcr.io/pazka/instantshit:$V` without login.
- `11-BOX-STANDARD.md` §4 port registry: 9136 → instantshit (pad.hosh.it). DNS `pad.hosh.it` already points at the box.

**1. Baseline (read-only)**
```sh
/home/pazka/MIGRATION/scripts/smoke.sh all                       # BEFORE
LEGACY_DIR=/root/hosh-deploy/instantshit                         # legacy compose dir (check: ls $LEGACY_DIR)
LEGACY_DATA=$(sudo docker inspect instantshit -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
echo "$LEGACY_DATA"                                              # expect $LEGACY_DIR/data
curl -fsS http://127.0.0.1:12121/all | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["file"], len(json.dumps(d["txt"]["val"])))' | tee /tmp/instantshit-before.txt
sudo sh -c "cd '$LEGACY_DATA' && ls -la && sha256sum currentFile meta.json currentText.json 2>/dev/null" | tee -a /tmp/instantshit-before.txt
sudo grep -o '^[A-Z_]*=' "$LEGACY_DIR/.env" 2>/dev/null           # variable NAMES only; TITLE is the only one that moves
```

**2. Release checkout + env file**
```sh
sudo mkdir -p /srv/instantshit && sudo chmod 750 /srv/instantshit && cd /srv/instantshit
[ -d .git ] || { sudo git init -q && sudo git remote add origin https://github.com/pazka/instant_shit; }
sudo git fetch -q --depth 1 origin tag $V && sudo git checkout -q $V
[ -e instantshit.env ] || sudo install -m 600 .env.example instantshit.env
sudo sed -i "s|^APP_IMAGE=.*|APP_IMAGE='ghcr.io/pazka/instantshit:$V'|" instantshit.env
# only if the legacy .env sets TITLE (owner copies the value; default QuickPaste = what the image used so far):
#   sudo sed -i "s|^TITLE=.*|TITLE='<value>'|" instantshit.env
```

**3. Register + deployer key**
```sh
sudo hosh-deploy register instantshit          # validates the compose hardening, pins it, copies the route template
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:instantshit -f /tmp/instantshit-deploy
sudo /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key instantshit /tmp/instantshit-deploy.pub
# owner (or agent if allowed), then shred:
gh secret set HOSH_DEPLOY_KEY -R pazka/instant_shit < /tmp/instantshit-deploy && shred -u /tmp/instantshit-deploy /tmp/instantshit-deploy.pub
```

**4. Stop legacy, move the data** (downtime starts; the legacy bind mount is only READ, never modified)
```sh
cd "$LEGACY_DIR" && sudo docker compose stop                     # stop, NOT down: rollback = start
sudo docker volume inspect instantshit-data >/dev/null 2>&1 && { echo "instantshit-data exists: STOP, inspect it"; false; }
sudo docker volume create instantshit-data
# copy with the legacy image already on the box (no pull), then hand everything to uid 10001
sudo docker run --rm --network none --user 0 --entrypoint sh \
  -v "$LEGACY_DATA":/from:ro -v instantshit-data:/to ghcr.io/pazka/instantshit:v0.1.1 \
  -c 'cp -a /from/. /to/ && chown -R 10001:10001 /to && ls -la /to && cd /to && sha256sum currentFile meta.json currentText.json 2>/dev/null'
```
Compare the sha256 lines with `/tmp/instantshit-before.txt` (they must be identical). `tmp/` holds only aborted
uploads, which the app deletes at start.

**5. Remove the legacy router** (it routes the same `Host(pad.hosh.it)`; two routers for one host = the new one may
lose, and a same-named router across files is a conflict → the first deploy's HTTPS check fails)
```sh
sudo grep -n -B2 -A8 'pad.hosh.it' /root/hosh-deploy/edge/traefik/dynamic/routes.yml   # find the router + its service
# delete that router (and its service if nothing else uses it), keep a copy for the revert:
sudo cp /root/hosh-deploy/edge/traefik/dynamic/routes.yml /root/routes.yml.pre-instantshit
sudoedit /root/hosh-deploy/edge/traefik/dynamic/routes.yml
curl -s http://127.0.0.1:8899/api/http/routers | python3 -c 'import json,sys; print([r["name"] for r in json.load(sys.stdin) if "pad.hosh.it" in r.get("rule","")])'   # expect []
```

**6. First deploy = GitHub Actions** (writes the route, POST_DEPLOY, automatic rollback)
```sh
gh workflow run deploy -R pazka/instant_shit -f version=$V     # or: sudo hosh-deploy deploy instantshit $V
sudo hosh-deploy status instantshit
```

**7. Smoke AFTER**
```sh
curl -fsS https://pad.hosh.it/healthz                            # status ok, dataWritable true, file {size,…} as before
curl -fsS https://pad.hosh.it/all | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["file"], len(json.dumps(d["txt"]["val"])))'   # = line 1 of /tmp/instantshit-before.txt
curl -fsS -o /tmp/instantshit-file https://pad.hosh.it/file && sha256sum /tmp/instantshit-file && rm /tmp/instantshit-file   # = currentFile sha256
sudo docker exec instantshit node /checks/postdeploy.js http://127.0.0.1:8000
sudo docker inspect instantshit -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.State.Health.Status}}'   # 10001:10001 true healthy
```
Browser: open https://pad.hosh.it in two tabs, type in one → appears in the other (owner, optional: upload a file).
Update the box smoke harness `svc_instantshit` (loopback port 12121 → 9136, add `/healthz`), run
`scripts/smoke.sh all` (AFTER), commit the new route file in `/root/hosh-deploy`. Keep `$LEGACY_DIR` (compose,
`.env`, `data/`) untouched for a while; remove it later with an owner 🛑 GATE.

**Rollback** (any step after 4 fails, or the new pad misbehaves):
```sh
sudo hosh-deploy rollback instantshit 2>/dev/null || (cd /srv/instantshit && sudo docker compose --env-file instantshit.env down)   # keeps the volume
sudo rm -f /root/hosh-deploy/edge/traefik/dynamic/instantshit.yml
sudo cp /root/routes.yml.pre-instantshit /root/hosh-deploy/edge/traefik/dynamic/routes.yml   # legacy router back
cd "$LEGACY_DIR" && sudo docker compose start && curl -fsS http://127.0.0.1:12121/title
```
The legacy `data/` was never written by the cutover, so the pad is back exactly as before step 4. Anything pasted
on the new instance after the cutover lives only in the `instantshit-data` volume (left untouched; copy back by hand
with the step-4 command reversed + `chown -R 1000:1000` if needed). Full revert of the registration:
`sudo rm /etc/hosh-deploy/apps/instantshit.conf` + `sudo .../setup-hosh-deploy.sh unkey instantshit` + delete the secret.
