#!/usr/bin/env bash
# Gmind 开发环境公共配置与工具函数（被 dev-start/stop/restart/status/logs 引用，不直接执行）。

# 固定端口约定（与 e2e 门禁一致）：server 3001、web 5174（3000 留给本机其他项目）。
export PORT="${PORT:-3001}"
export API_ORIGIN="${API_ORIGIN:-http://localhost:${PORT}}"
export WEB_PORT="${WEB_PORT:-5174}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_ROOT/.data"
LOG_FILE="$DATA_DIR/dev-server.log"
PID_FILE="$DATA_DIR/dev-server.pids"

mkdir -p "$DATA_DIR"

web_url() { echo "http://localhost:${WEB_PORT}"; }
api_url() { echo "http://localhost:${PORT}"; }

# 端口是否已有监听（有 = 对应服务在跑）。
port_busy() { lsof -nP -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

# 服务健康检查（/api/health 返回 {"ok":true,"db":true} 视为健康）。
api_healthy() {
  curl -sf --max-time 3 "$(api_url)/api/health" 2>/dev/null | grep -q '"ok":true'
}

# 记录本次启动的进程组 pid（stop 用）。
save_pids() { echo "$1" > "$PID_FILE"; }
