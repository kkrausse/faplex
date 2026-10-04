#!/bin/sh
# Starts the real faplex on `laptop` under termctrl, waits for all nine seeded rows, and prints
# the screen. Leaves the termctrl session running (named faplex-e2e) unless KEEP=0.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
export TERMCTRL_RUNTIME_DIR=/tmp/tc-faplex-e2e
mkdir -p -m 700 "$TERMCTRL_RUNTIME_DIR"
s=faplex-e2e
termctrl stop $s >/dev/null 2>&1 || true
termctrl start $s --host opentui --cols "${COLS:-120}" --rows "${ROWS:-30}" -- "$here/faplex.sh"
termctrl wait $s "Document the backup script" --timeout 30000
termctrl wait $s "Bump the terraform provider" --timeout 30000
termctrl wait $s "Tidy the landing page copy" --timeout 30000
termctrl show $s
[ "${KEEP:-1}" = 1 ] || termctrl stop $s >/dev/null 2>&1 || true
