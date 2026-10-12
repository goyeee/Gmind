#!/usr/bin/env bash
# 查看开发环境状态：端口监听 / 健康检查 / 日志尾部。
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-common.sh"

echo "web  $(web_url) : $(port_busy "$WEB_PORT" && echo 运行中 || echo 未启动)"
echo "api  $(api_url) : $(port_busy "$PORT" && echo 运行中 || echo 未启动)"
if api_healthy; then
  echo "健康检查：通过 ✓"
else
  echo "健康检查：未通过（服务未起或 DB 未连）"
fi
if [[ -f "$LOG_FILE" ]]; then
  echo "—— 日志尾部（.data/dev-server.log）——"
  tail -10 "$LOG_FILE"
fi
