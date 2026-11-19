# Testing

Safety net for upgrades (Node base image, Express / express-fileupload / express-rate-limit / Socket.IO,
Actions): it pins what the shared paste page does today so a Dependabot PR is judged on its CI run.

## Run it

```bash
# server tests: black-box, spawns `node server.js` (DEV config.json, DATA_DIR in a temp dir)
docker run --rm -v "$PWD":/src:ro node:26-alpine sh -c \
  'mkdir /a && cd /src && tar --exclude=./node_modules --exclude=./data -cf - . | tar -xf - -C /a && cd /a \
   && npm ci --ignore-scripts && node --test --test-reporter=spec test/server.test.js test/log.test.js'

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

`test/log.test.js` (16 tests): the logging standard (hosh-management AGENTS.md §11), see `DEPLOY.md` §5 "Logs".
`log.js` unit tests (line format, level filter, `LOG_LEVEL` / `APP_LOG_LEVEL`, `errField`, `requestId`, route
templates); the request logger on a real Express app (5xx = one `request_failed` error line with `err`, slow =
`request_slow` warn, the rest and `/healthz` at debug, `X-Request-Id` kept or generated); `server.js` black box:
the `startup` line (version, port, `data_dir_writable` true, and false on a read-only data dir run as a non-root
uid, config names without values), `file_uploaded`, `shutdown` on SIGTERM writes a pending notepad edit first
(exit 0), `upload_failed` + `request_failed` on a failing upload (answer unchanged), `restore_failed` on unreadable
saved state, a SIGTERM during a save on a slow disk (`test/slow-write-preload.js` delays `fs.writeFile`) keeps
the notepad and `meta.json` whole (saves write a `.part` file, then rename it), `persist_failed` (text and file
metadata, async and on shutdown), `healthz_failed` + 503 on an unwritable data dir, `request_failed` with `err`
on an error Express answers itself (unreadable download); tests that need a non-root uid run the server as
nobody (65534) when the suite runs as root (CI's node container), debug lines; stdout is only JSON, stderr stays empty (Express env "test"), and no paste, file name,
path, query string, socket id or IP is ever logged.

`scripts/smoke.sh`: the built image with the production config (`QuickPaste`, 2 GiB / 100 000 limits),
hardened, upload/download, engine.io handshake, file kept across `docker restart`.

`scripts/smoke-compose.sh legacy`: the box's legacy compose verbatim (only the image differs): production config,
notepad edit over Socket.IO seen by a second client, upload/download round-trip (`scripts/capability.js`, needs
`node` on the host), files in the bind mount owned by uid 1000 with an empty `tmp/`, text and file still served
after `restart` and after `down`/`up`, nothing written outside `/data`, clean logs.
`scripts/smoke-compose.sh template`: the same checks with `docker-compose.example.yml` + `.env.example` as
hosh-deploy runs them (fresh named volume, uid 10001, read-only, pids 128, mem 3g), plus the register
validation (`scripts/check-hosh-deploy.sh`), healthcheck `healthy`, `/healthz` (GET + HEAD), the `POST_DEPLOY`
command of `deploy/hosh-deploy.conf` inside the container (`checks/postdeploy.js`, read-only), and a 1 GiB
upload/download under the compose `mem_limit` (3g) without OOM (peak cgroup memory printed). Both modes also run in `release.yml` before anything is pushed.

## Visual use cases (visual regression, hosh-management AGENTS.md §3)

`visual/run.sh IMAGE` (CI `container smoke`, last step): the built image runs hardened as hosh-deploy runs it
(uid 10001, read-only, cap_drop ALL, no-new-privileges, `PORT=8000`, a fresh empty `/data` volume, the image's
production config: `QuickPaste`, 2 GiB / 100 000 limits) on `http://localhost:9875`. Two headless Chromes of the
runner (mouse for 1400 / 1024, touch for 390) resolve every other host name to nothing, and `visual/shoot.mjs`
runs with the image's own node (no package): every case below at **1400, 1024 and 390 px**, a new visitor (new
browser context) for each shot, compared with `visual/baseline/<id>-<width>.png` (tolerance: channel 24, 0.1 %
of the pixels). Copied from pazka/MyMurderParty `visual/` (itself from pazka/plats). A failing shot is printed
in the CI log; `node visual/from-log.mjs <log> [dir]` writes it back as a PNG. Locally (no Docker):
`node server.js` with `config.prod.json`, `TITLE=QuickPaste`, `PORT=9875`, an empty `DATA_DIR`, then
`CHROME=/path/to/chrome node visual/shoot.mjs http://localhost:9875`.

The server holds ONE shared paste and ONE file, so the cases run in this order on one container, and a step
only changes the shared state when it is not there yet (every width of a case sees the same state):

| id | page / state | steps |
|---|---|---|
| E1-empty | fresh server: empty pad, "No file has been shared yet.", max 2.00 Go | none |
| E2-drag-over | a file dragged over the drop zone (highlighted), nothing shared yet | dragenter + dragover on `#drop-zone` |
| T1-text | the pad as a new visitor sees it after someone typed a 5-line list | type in the editor, wait for the server, reload |
| T2-text-too-big | the sender typed past 100 000 characters: red "Text is too big !" error, pad scrolled to the top | + type 16 700 x "paste " at the end |
| F1-file-shared | text + a shared file: download button `holiday-photos.zip`, 120.6 Ko | + drop a 123 456-byte file on the drop zone (`DataTransfer`, the page's real upload), reload |
| F2-file-drag-over | a file dragged over the drop zone while a file is shared | + dragenter + dragover |

Pinned so a diff means a real change: the "Last update" dates (`#txtMaj`, `#fileMaj`, they come from the clock)
show `01/01/2026 12:00:00`; animations, transitions and the caret are off; the window is scrolled to the top.

Not covered, and why:
- The upload progress bar (`#upload-status`): it lasts as long as the upload, too short to shoot reliably.
- Upload errors (429 after 15 uploads in 10 min, 413 over 2 GiB, "an upload is already running"), the "Slow down !"
  edit throttle and the live sync between two windows: covered by `test/server.test.js` and the compose smokes,
  not by pictures.
- Hover states (the download button turns red): not shot.

Seen while building the harness, not changed (owner decision if wanted): on a phone (portrait) a single
unbroken word of 100 000 letters makes the text panel 650 000 px wide (`.ql-editor` does not break it in the
column layout); and the full-page phone shots end the gradient at 900 px (`background-attachment: fixed`).

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
  `node:26.13.1-alpine@sha256:…` (Dependabot `docker` bumps tag and digest), Node 20 dropped from the test
  matrix (EOL).

## Notes (not changed)

- No authentication by design: anyone with the URL can read and replace the paste and the file.
- Image runs as root by default (works as uid 1000 and 10001, see the smokes). HEALTHCHECK on `/healthz` since
  the hosh-deploy migration (`PORT` and `DATA_DIR` from env, defaults 80 and `/data` = legacy compose).
- `.gitignore` had `.idea` and `data/` merged on one line (`.ideadata/`), so neither was ignored; fixed.
  `.dockerignore` added so a local `data/` (pastes) or tests never end up in the image.
