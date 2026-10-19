# CLAUDE.md — pazka/instant_shit

Shared paste page (one notepad synced over Socket.IO + one file slot), `server.js` + static `www/`.
Deployed twice from the same image (docker-compose.yml). Owner: Alexandre (pazka). Read **TESTING.md** first.

## Maintenance (autonomous agent)
Goal: keep the base image, dependencies and Actions current **without changing behaviour**.
- **Gate = `ci` green**: `server tests (node 20|26)` + `container smoke`.
- **Branches**: work on `agent/<topic>`; CI runs without a PR. Never push to `master` (`deploy.yml` /
  `release.yml` publish from it), never tag. **The owner merges.**
- **Dependabot PRs**: green → summarise risk in a PR comment. Red → reproduce per TESTING.md, smallest fix on
  an `agent/` branch. Never weaken or delete a test; the limits and rate limits are deliberate.
- When the base image major moves, move the test matrix to `[new, next]` and update TESTING.md.

## Rules
- Never read or commit `data/` (users' pastes and files).
- No new dependency without the owner's yes (tests use Node built-ins only).
- Run installs and tests in containers (TESTING.md), not on the owner's machine.
