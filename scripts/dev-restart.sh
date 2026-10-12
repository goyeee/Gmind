#!/usr/bin/env bash
# 重启 Gmind 开发环境（stop → start），拉取代码后让新代码生效就走这个。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/dev-stop.sh"
exec "$SCRIPT_DIR/dev-start.sh"
