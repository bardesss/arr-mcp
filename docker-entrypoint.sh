#!/bin/sh
set -e

# linuxserver-style PUID/PGID so the /config bind mount stays writable by the
# host user who owns it.
PUID=${PUID:-1000}
PGID=${PGID:-1000}
CONFIG_DIR=${ARR_MCP_CONFIG_DIR:-/config}

if [ "$(id -u)" = "0" ]; then
    # `node` is the base image's non-root account, already at 1000:1000.
    groupmod -o -g "$PGID" node 2>/dev/null || true
    usermod -o -u "$PUID" node 2>/dev/null || true
    mkdir -p "$CONFIG_DIR"
    chown -R "$PUID:$PGID" "$CONFIG_DIR"
    exec gosu node "$@"
fi

# Already unprivileged (e.g. `docker run --user`): run as-is.
exec "$@"
