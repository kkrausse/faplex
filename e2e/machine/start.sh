#!/bin/sh
# Runs as `dev` when the container starts: bring up the session-owning daemons, seed, then idle.
# Claude's daemon needs no start: `claude --bg` in the seed launches it on demand.
# ~/.e2e-seeded is the container's health check; a failed seed leaves the container unhealthy
# with the reason in ~/e2e-logs/seed.log.
cd "$HOME" || exit 1
mkdir -p "$HOME/src" "$HOME/e2e-logs"
rm -f "$HOME/.e2e-seeded"

codex app-server daemon start > "$HOME/e2e-logs/codex-daemon.log" 2>&1
opencode service start > "$HOME/e2e-logs/opencode-service.log" 2>&1

if bun /e2e/seed.ts > "$HOME/e2e-logs/seed.log" 2>&1; then
  touch "$HOME/.e2e-seeded"
fi
exec sleep infinity
