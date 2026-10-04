#!/bin/sh
# Why is the rig unhealthy? Seed and daemon logs of every machine, then what the fake API saw.
here=$(cd "$(dirname "$0")" && pwd)
for m in laptop devbox pi; do
  echo "== $m"
  "$here/x" "$m" 'tail -n 6 ~/e2e-logs/seed.log; tail -n 2 ~/e2e-logs/codex-daemon.log | cut -c1-200; tail -n 1 ~/e2e-logs/opencode-service.log; ls ~/.e2e-seeded 2>&1'
done
echo "== fakeapi (unhandled request paths)"
"$here/x" laptop 'curl -s fakeapi:8080/_control/unhandled'
echo
echo "== fakeapi (handled, by wire and path)"
"$here/x" laptop 'curl -s fakeapi:8080/_control/log' | jq -r '.[] | select(.handled) | "\(.wire) \(.method) \(.path) \(.note // "" | if startswith("side:") then . else "" end)"' | sort | uniq -c
