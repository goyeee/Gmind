# Windows 本机配置加载回归测试：pnpm 无此测试依赖，直接运行本文件。
# 验证方式：在临时目录复制真实 dev.ps1，以 dev-local.env 覆盖状态命令显示的端口。
$ErrorActionPreference = 'Stop'
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "gmind-dev-env-test-$([guid]::NewGuid())"

try {
  $TempScripts = New-Item -ItemType Directory -Path (Join-Path $TempRoot 'scripts') -Force
  Copy-Item (Join-Path $PSScriptRoot 'dev.ps1') (Join-Path $TempScripts 'dev.ps1')
  Set-Content -Path (Join-Path $TempScripts 'dev-local.env') -Value "PORT='33991'`nWEB_PORT='35174'" -NoNewline

  $Output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $TempScripts 'dev.ps1') status 2>&1 | Out-String
  if ($Output -notmatch 'http://localhost:33991' -or $Output -notmatch 'http://localhost:35174') {
    throw "dev.ps1 未加载 dev-local.env。输出：`n$Output"
  }

  Write-Host 'dev.ps1 本机配置加载测试通过'
} finally {
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
