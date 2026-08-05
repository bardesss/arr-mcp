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

# Already unprivileged (e.g. `docker run --user`). We cannot chown from here,
# so the config volume has to be writable by this uid already. Say so plainly
# rather than letting Node fail with a bare EACCES stack trace, which is what
# it did before and tells the user nothing about what to change.
mkdir -p "$CONFIG_DIR" 2>/dev/null || true
if [ ! -w "$CONFIG_DIR" ]; then
    echo "arr-mcp: $CONFIG_DIR is not writable by uid $(id -u)." >&2
    echo "  Running with --user means the container cannot fix this itself." >&2
    echo "  Either chown the directory on the host:" >&2
    echo "      chown -R $(id -u):$(id -g) <your config dir>" >&2
    echo "  or drop --user and set PUID/PGID instead, which does it for you." >&2
    exit 1
fi

exec "$@"
