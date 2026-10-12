#!/usr/bin/env bash
# 启动 Gmind 开发环境（server + web 并行，日志落 .data/dev-server.log）。
# 已在跑则直接提示并退出（要重来请用 dev-restart.sh）。
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-common.sh"

if port_busy "$PORT" || port_busy "$WEB_PORT"; then
  echo "[dev] 已在运行：web=$(web_url) api=$(api_url)（重启请用 scripts/dev-restart.sh）"
  exit 0
fi

echo "[dev] 启动 server(:$PORT) + web(:$WEB_PORT)，日志：.data/dev-server.log"
cd "$REPO_ROOT"
nohup pnpm dev > "$LOG_FILE" 2>&1 &
save_pids $!

# 等健康（最多 30s）
for _ in $(seq 1 30); do
  if api_healthy && port_busy "$WEB_PORT"; then
    echo "[dev] 就绪 ✓  web=$(web_url)  api=$(api_url)（健康检查通过）"
    exit 0
  fi
  sleep 1
done

echo "[dev] 30s 内未就绪——最近日志："
tail -20 "$LOG_FILE"
exit 1
