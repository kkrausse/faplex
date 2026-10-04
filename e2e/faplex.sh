#!/bin/sh
# The real faplex on `laptop`, in this terminal. The rig must be up (see compose.yaml).
here=$(cd "$(dirname "$0")" && pwd)
exec docker compose -f "$here/compose.yaml" exec -u dev -w /home/dev/src/shop-api \
  -e TERM="${TERM:-xterm-256color}" -e COLORTERM=truecolor laptop faplex "$@"
