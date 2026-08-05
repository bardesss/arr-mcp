#!/bin/sh
set -e

# linuxserver-style PUID/PGID so the /config bind mount stays writable by the
# host user who owns it.
PUID=${PUID:-1000}
PGID=${PGID:-1000}
CONFIG_DIR=${ARR_MCP_CONFIG_DIR:-/config}

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$CONFIG_DIR"
    chown -R "$PUID:$PGID" "$CONFIG_DIR"

    # Drop straight to the numeric ids rather than rewriting the base image's
    # `node` account with usermod/groupmod first.
    #
    # Those tools live in the `passwd` package and are not guaranteed present
    # in a slim base image. The previous version hid that behind
    # `2>/dev/null || true`, which turned a missing binary into a container
    # that starts and *then* cannot write its own config: chown had already
    # applied PUID, but the process still ran as uid 1000. gosu takes uid:gid
    # directly, needs neither tool, and cannot half-succeed.
    exec gosu "$PUID:$PGID" "$@"
fi

# Already unprivileged (e.g. `docker run --user`): run as-is.
exec "$@"
