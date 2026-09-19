#!/usr/bin/env bash
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: Bardesss
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/bardesss/arr-mcp

APP="arr-mcp"
var_tags="${var_tags:-arr;mcp;ai}"
var_cpu="${var_cpu:-2}"
# Sized for the optional IMDb dataset, not for serving: the ingest holds ~1.7M
# ratings in memory in its worker thread, measured at ~650 MB in docs/imdb.md.
# Idle with the dataset off is a couple of hundred megabytes.
var_ram="${var_ram:-2048}"
# Debian plus Node plus the dependency tree is most of this. The IMDb dataset
# adds ~81 MB kept and a 224 MB download each weekly refresh on top.
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
#var_arm64="${var_arm64:-no}" # unset = ask the user; set yes/no only when verified
var_unprivileged="${var_unprivileged:-1}"
# Where a container built from here should report. These scripts live in the
# arr-mcp repository rather than the Community Scripts one, and will for a long
# time yet, so pointing this at the Community Scripts tracker would send every
# tester to a repository that does not carry the script they are reporting on.
var_testurl="${var_testurl:-https://github.com/bardesss/arr-mcp/issues/265}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/arr-mcp ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "arr-mcp" "bardesss/arr-mcp"; then
    msg_info "Stopping Service"
    systemctl stop arr-mcp
    msg_ok "Stopped Service"

    # No create_backup: /opt/arr-mcp holds nothing but code. config.yaml, the
    # bearer token, the log and audit databases and the IMDb dataset are all in
    # /config, which the clean re-deploy below does not reach.
    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "arr-mcp" "bardesss/arr-mcp" "tarball"

    NODE_VERSION="24" setup_nodejs

    msg_info "Building arr-mcp"
    cd /opt/arr-mcp
    export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    $STD npm ci
    $STD npm run build
    $STD npm prune --omit=dev
    echo "ARR_MCP_VERSION=$(node -p "require('/opt/arr-mcp/package.json').version")" >/opt/arr-mcp.env
    msg_ok "Built arr-mcp"

    msg_info "Starting Service"
    systemctl start arr-mcp
    msg_ok "Started Service"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Claim it before you expose the port: until someone does, whoever loads that page first owns the instance.${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:6060${CL}"
