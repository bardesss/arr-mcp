#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: Bardesss
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/bardesss/arr-mcp

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
# better-sqlite3 is a native addon. It ships prebuilt binaries and normally uses
# one, but the fallback is to compile, and without a toolchain that fallback is
# a failed install rather than a slow one. The Dockerfile's build stage installs
# python3, make and g++ for the same reason; build-essential covers the last two.
$STD apt install -y build-essential python3
msg_ok "Installed Dependencies"

fetch_and_deploy_gh_release "arr-mcp" "bardesss/arr-mcp" "tarball"

# 24 because that is what the published image runs, not the >=24 floor in
# engines: the container should get the runtime the release was tested on.
NODE_VERSION="24" setup_nodejs

msg_info "Building arr-mcp"
cd /opt/arr-mcp
# Playwright is a devDependency of the screenshot script alone. Its install step
# downloads a browser this container will never open, so skip it — the build
# below never touches Playwright.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
$STD npm ci
$STD npm run build
$STD npm prune --omit=dev
msg_ok "Built arr-mcp"

msg_info "Creating Service"
# Created here rather than left to the server: it opens its log and audit
# databases in this directory as the first thing it does, before the config
# loader that would have created it runs. A missing /config is SQLITE_CANTOPEN
# at startup, not a first-run mkdir.
mkdir -p /config
# Read out of the deployed tree so it cannot drift from the release that is
# actually installed, and written outside /opt/arr-mcp because an update is a
# clean re-deploy of that directory.
echo "ARR_MCP_VERSION=$(node -p "require('/opt/arr-mcp/package.json').version")" >/opt/arr-mcp.env
cat <<'EOF' >/etc/systemd/system/arr-mcp.service
[Unit]
Description=arr-mcp
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/arr-mcp
Environment=NODE_ENV=production
# The same two the image sets, so a container and an LXC put config.yaml in the
# same place and answer on the same port.
Environment=ARR_MCP_CONFIG_DIR=/config
Environment=ARR_MCP_PORT=6060
# What /healthz and the MCP handshake report. Rewritten from the deployed
# package.json on every update rather than pinned into this unit. Optional on
# purpose: a version string that failed to be written is a cosmetic problem, and
# without the leading - systemd would turn it into a service that will not start.
EnvironmentFile=-/opt/arr-mcp.env
ExecStart=/usr/bin/node /opt/arr-mcp/dist/src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now arr-mcp
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
