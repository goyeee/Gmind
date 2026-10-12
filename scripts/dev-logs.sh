#!/usr/bin/env bash
# 实时跟踪开发环境日志（Ctrl+C 退出，不影响服务）。
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-common.sh"
[[ -f "$LOG_FILE" ]] || { echo "[dev] 还没有日志（先 scripts/dev-start.sh）"; exit 0; }
tail -f "$LOG_FILE"
