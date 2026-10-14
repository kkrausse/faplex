#!/bin/sh
# Two repros around leaving a new chat. First: "back" from a new chat whose first prompt arrived as one input chunk (text and Enter
# together, as a paste or dictation sends it) used to land on the new-session picker, although the
# prompt had gone in. It must land on the list. The rig must be up (see compose.yaml).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
export TERMCTRL_RUNTIME_DIR=/tmp/tc-faplex-e2e
mkdir -p -m 700 "$TERMCTRL_RUNTIME_DIR"
s=faplex-e2e-back
trap 'termctrl stop $s >/dev/null 2>&1 || true' EXIT
termctrl start $s --host opentui --cols 120 --rows 30 -- "$here/faplex.sh"
termctrl wait $s "Finished 1" --timeout 30000
termctrl send $s text:n; termctrl wait $s "New session"
termctrl send $s enter; termctrl wait $s "for agents" --timeout 30000
sleep 1
printf 'write release notes for v0.2\r' | termctrl send $s --stdin
printf '\035' | termctrl send $s --stdin   # ctrl+]
termctrl wait $s "Working 2" --timeout 15000 || { termctrl show $s; echo "FAIL: not back on the list"; exit 1; }
echo "ok: back on the list"

# Repro: ← in a new Claude session that is working fell through to Claude Code, which opened its
# own agents list. Claude hides the terminal's cursor in a session it started, and the empty-prompt
# check only trusted a visible one. ← must come back to the list.
termctrl send $s text:n; termctrl wait $s "New session"
termctrl send $s down enter; termctrl wait $s "for agents" --timeout 30000
sleep 1
termctrl send $s "text:fix the flaky checkout test"; sleep 0.3; termctrl send $s enter
sleep 2
termctrl send $s left
termctrl wait $s "Working 3" --timeout 15000 || { termctrl show $s; echo "FAIL: ← did not come back to the list"; exit 1; }
echo "ok: ← from a working new session is back on the list"

# Repro: a session started from the picker on a prompt runs hidden at full height, so opening it
# was no resize, Claude never repainted, and the screen showed only its spinner line. It must open
# fully drawn.
termctrl send $s text:n; termctrl wait $s "New session"
termctrl send $s "text:draft the changelog"; sleep 0.3; termctrl send $s enter
termctrl wait $s "draft the changelog" --timeout 15000
sleep 4
for _ in 1 2 3 4 5 6 7 8; do
  termctrl show $s | grep -q "claude · draft the changelog ·" && break
  termctrl send $s down; sleep 0.3
done
termctrl send $s enter
termctrl wait $s "❯ draft the changelog" --timeout 15000 || { termctrl show $s; echo "FAIL: a session started on a prompt opened half drawn"; exit 1; }
echo "ok: a session started on a prompt opens fully drawn"

# Repro: an Enter pressed again right after starting a session on a prompt landed on the list and
# opened the new row. It must stay on the list.
printf '\035' | termctrl send $s --stdin; sleep 1
termctrl send $s text:n; termctrl wait $s "New session"
termctrl send $s "text:count the files"; sleep 0.3; termctrl send $s enter; sleep 0.5; termctrl send $s enter
sleep 3
termctrl show $s | grep -q "+ new session" || { termctrl show $s; echo "FAIL: a second Enter opened the new session"; exit 1; }
echo "ok: a second Enter after starting on a prompt stays on the list"
