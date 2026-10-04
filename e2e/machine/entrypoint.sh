#!/bin/sh
# Container entrypoint (root): sshd for the other machines, then the dev user starts the daemons and seeds.
set -eu
/usr/sbin/sshd
exec su dev -c "exec /e2e/start.sh"
