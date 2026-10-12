#!/usr/bin/env bash
# 停止 Gmind 开发环境：优先按 pid 文件杀进程组，兜底按端口清残留
# （只动 3001/5174——Gmind 专用端口，不影响本机其他项目）。
set -uo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-common.sh"

if [[ -f "$PID_FILE" ]]; then
  pgid=$(cat "$PID_FILE")
  # 负号 = 杀整个进程组（nohup 启动的 pnpm dev 及其 server/web 子进程）
  kill -- "-$pgid" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

# 兜底：端口上仍监听的进程一律结束（Gmind 专用端口，安全）
for port in "$PORT" "$WEB_PORT"; do
  pids=$(lsof -t -nP -i ":$port" -sTCP:LISTEN 2>/dev/null || true)
  [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
done
sleep 1

if port_busy "$PORT" || port_busy "$WEB_PORT"; then
  echo "[dev] 仍有残留监听（$PORT/$WEB_PORT），请手动检查：lsof -nP -i :$PORT -i :$WEB_PORT"
  exit 1
fi
echo "[dev] 已停止 ✓"
