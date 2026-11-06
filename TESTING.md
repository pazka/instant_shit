# Testing

Safety net for upgrades (Node base image, Express / express-fileupload / express-rate-limit / Socket.IO,
Actions): it pins what the shared paste page does today so a Dependabot PR is judged on its CI run.

## Run it

```bash
# server tests: black-box, spawns `node server.js` (DEV config.json, DATA_DIR in a temp dir)
docker run --rm -v "$PWD":/src:ro node:26-alpine sh -c \
  'mkdir /a && cd /src && tar --exclude=./node_modules --exclude=./data -cf - . | tar -xf - -C /a && cd /a \
   && npm ci && node --test --test-reporter=spec test/server.test.js'

# container smoke (hardened: uid 1000, read-only rootfs, /data volume, restart)
docker build -t instantshit:smoke . && bash scripts/smoke.sh instantshit:smoke

# compose modes: the box's legacy compose today (uid 1000, :80 on 127.0.0.1:12121, bind mount ./data)
bash scripts/smoke-compose.sh legacy instantshit:smoke
# ... and the hosh-deploy compose (docker-compose.example.yml + .env.example: uid 10001, read-only, PORT=8000,
# volume instantshit-data — refuses to run if that volume already exists) incl. register validation + POST_DEPLOY
bash scripts/smoke-compose.sh template instantshit:smoke
bash scripts/check-hosh-deploy.sh     # what `hosh-deploy register` validates (also run by the template smoke)

# Node runtime guardrail (fails on EOL Node or below the patched minimum, CVE-2026-111497)
bash scripts/check-node-version.sh instantshit:smoke
```

(Windows Git Bash: prefix `docker run` with `MSYS_NO_PATHCONV=1`, mount `"$(cygpath -w "$PWD")"`.)

## CI (`.github/workflows/ci.yml`)

PRs, `master`, `agent/**`: `server tests (node 26)` and `container smoke` (which also runs
`scripts/check-node-version.sh` on the built image and checks that it rejects `node:24.21.0-alpine`, then
`smoke.sh` and `smoke-compose.sh legacy|template`).
`release.yml` and `build-scan-push.yml` run the same guardrail on the candidate image before anything is pushed;
`deploy.yml` is the hosh-deploy deploy (DEPLOY.md), a no-op while the repo has no `HOSH_DEPLOY_KEY`.

## What is covered

`test/server.test.js` (9 tests, Node built-ins; `test/sio-poll.js` is a tiny Socket.IO long-polling client
on `fetch`): `/healthz` (GET/HEAD, shape, no probe file left), page, `/socket.io/socket.io.js`, `/title`, `/limits`, `/all`, `/file` 404; upload 400 / 200 /
download with the original name / `new_file` broadcast / both 413 paths; notepad `my-id`, `txt_update` →
`new_text` to every client, text size limit to the sender only; state restored after a restart
(`meta.json`, `currentFile`, `currentText.json`); upload rate limit (15 per 10 min → 429); Express default
404/400/415/416 error pages, case-insensitive routes with optional trailing slash, static `index.html` /
dotfile / traversal fallbacks, CORS preflight; `/file` `Content-Disposition` byte-for-byte (quoted name, latin1
`?` fallback + `filename*`), HEAD and ranges; draft-6 `RateLimit-*` headers, one bucket per client IP via
`X-Forwarded-For` (IPv6 addresses not grouped by subnet).

`scripts/smoke.sh`: the built image with the production config (`QuickPaste`, 2 GiB / 100 000 limits),
hardened, upload/download, engine.io handshake, file kept across `docker restart`.

`scripts/smoke-compose.sh legacy`: the box's legacy compose verbatim (only the image differs): production config,
notepad edit over Socket.IO seen by a second client, upload/download round-trip (`scripts/capability.js`, needs
`node` on the host), files in the bind mount owned by uid 1000 with an empty `tmp/`, text and file still served
after `restart` and after `down`/`up`, nothing written outside `/data`, clean logs.
`scripts/smoke-compose.sh template`: the same checks with `docker-compose.example.yml` + `.env.example` as
hosh-deploy runs them (fresh named volume, uid 10001, read-only, pids 128, mem 512m), plus the register
validation (`scripts/check-hosh-deploy.sh`), healthcheck `healthy`, `/healthz` (GET + HEAD), the `POST_DEPLOY`
command of `deploy/hosh-deploy.conf` inside the container (`checks/postdeploy.js`, read-only), and a 1 GiB
upload/download under the 512m limit without OOM. Both modes also run in `release.yml` before anything is pushed.

## Upgrades checked (2026-10-19)

- **Node 20 → 26** (Dependabot #3): tests 5/5 on 26.12, hardened smoke OK on `node:26-alpine` → **applied** (Dockerfile on `node:26-alpine`).
- **Express 4.22 → 5.3, body-parser 1.20 → 2.3, express-rate-limit 7.5 → 8.7** (Dependabot #11, #9, #10, one
  branch): tests 8/8 on node 20 and 26, smoke OK → **applied** with `server.js` keeping the old behaviour:
  `/file` uses `res.sendFile` with `dotfiles: 'allow'` (Express 5's `res.download` 404s when the data path
  contains a dot-directory, e.g. the tests' `.test-data-*`) and the Express 4 `Content-Disposition` format
  (Express 5 unquotes token-only names and uses `?` fallbacks differently); rate limiters set
  `ipv6Subnet: false` (v8 groups IPv6 clients by /56). Remaining differences, not observable by the page:
  static `charset=utf-8` instead of `UTF-8` (case-insensitive), dev-mode error-page stack traces, and
  express-rate-limit 8 keys an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as `a.b.c.d`.

- **Node 26.13.0** (2026-11-06, hosh-management#5, CVE-2026-111497 fixed in 26.12.1): base image pinned to
  `node:26.13.0-alpine@sha256:…` (Dependabot `docker` bumps tag and digest), Node 20 dropped from the test
  matrix (EOL).

## Notes (not changed)

- No authentication by design: anyone with the URL can read and replace the paste and the file.
- Image runs as root by default (works as uid 1000 and 10001, see the smokes). HEALTHCHECK on `/healthz` since
  the hosh-deploy migration (`PORT` and `DATA_DIR` from env, defaults 80 and `/data` = legacy compose).
- `.gitignore` had `.idea` and `data/` merged on one line (`.ideadata/`), so neither was ignored; fixed.
  `.dockerignore` added so a local `data/` (pastes) or tests never end up in the image.
