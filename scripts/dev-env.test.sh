#!/usr/bin/env bash
# Bash 本机配置加载回归测试：直接运行本文件，不连接或停止任何服务。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/scripts"
cp "$REPO_ROOT/scripts/dev-common.sh" "$TEMP_ROOT/scripts/dev-common.sh"

# 保留模板本身的引号风格，仅把占位授权码替换为含 $HOME 的字面量。
# 双引号模板会错误展开 $HOME；单引号模板必须原样保留。
while IFS= read -r line; do
  if [[ "$line" == SMTP_PASS=* ]]; then
    value="${line#SMTP_PASS=}"
    quote="${value:0:1}"
    printf 'SMTP_PASS=%sliteral-$HOME-token%s\n' "$quote" "$quote"
  else
    printf '%s\n' "$line"
  fi
done < "$REPO_ROOT/scripts/dev-local.env.example" > "$TEMP_ROOT/scripts/dev-local.env"
printf '\nPORT=33991\nWEB_PORT=35174\n' >> "$TEMP_ROOT/scripts/dev-local.env"

failures=0

(
  # shellcheck source=/dev/null
  source "$TEMP_ROOT/scripts/dev-common.sh"
  [[ "$SMTP_PASS" == 'literal-$HOME-token' ]]
) || {
  echo 'FAIL: Bash 加载模板后改写了 SMTP_PASS 的字面值'
  failures=$((failures + 1))
}

(
  unset API_ORIGIN
  # shellcheck source=/dev/null
  source "$TEMP_ROOT/scripts/dev-common.sh"
  [[ "$PORT" == '33991' && "$API_ORIGIN" == 'http://localhost:33991' && "$WEB_PORT" == '35174' ]]
) || {
  echo 'FAIL: dev-local.env 覆盖 PORT 后，API_ORIGIN 没有同步跟随'
  failures=$((failures + 1))
}

if (( failures > 0 )); then
  exit 1
fi

echo 'Bash 本机配置加载测试通过'
