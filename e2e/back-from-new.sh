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
