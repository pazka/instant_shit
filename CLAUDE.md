# CLAUDE.md — pazka/instant_shit

Shared paste page (one notepad synced over Socket.IO + one file slot), `server.js` + static `www/`.
Deployed at pad.hosh.it. Today: the box's legacy compose (reference copy: `docker-compose.yml`); target: hosh-deploy
(`docker-compose.example.yml`, `deploy/`, **DEPLOY.md**, `docs/BOX-CONTRACT.md` binding). The image must keep
working with BOTH (CI: `scripts/smoke-compose.sh legacy|template`). Owner: Alexandre (pazka). Read **TESTING.md** first.

## Maintenance (autonomous agent)
Goal: keep the base image, dependencies and Actions current **without changing behaviour**.
- **Gate = `ci` green**: `server tests (node 26)` + `container smoke` (incl. the Node guardrail `scripts/check-node-version.sh`).
- **Branches**: work on `agent/<topic>`; CI runs without a PR. Never push to `master` (`build-scan-push.yml` /
  `release.yml` publish from it), never tag (a `vX.Y.Z` tag deploys to pad.hosh.it once `HOSH_DEPLOY_KEY` is set).
  **The owner merges.**
- **Dependabot PRs**: green → summarise risk in a PR comment. Red → reproduce per TESTING.md, smallest fix on
  an `agent/` branch. Never weaken or delete a test; the limits and rate limits are deliberate.
- When the base image major moves, move the test matrix to `[new, next]` and update TESTING.md.

## Rules
- Never read or commit `data/` (users' pastes and files).
- No new dependency without the owner's yes (tests use Node built-ins only).
- Run installs and tests in containers (TESTING.md), not on the owner's machine.
