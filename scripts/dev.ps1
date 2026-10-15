# Gmind 开发环境管理 —— Windows PowerShell 版（与 scripts/dev-*.sh bash 族等价，两平台均可启动）。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1 start|stop|restart|status|logs
# 或（已允许脚本的会话）：
#   .\scripts\dev.ps1 start
#
# 环境变量覆盖（与 bash 版 dev-common.sh 同口径）：
#   $env:PORT      = '3001'                            # API 端口（3000 留给本机其他项目）
#   $env:WEB_PORT  = '5174'                            # 前端端口
#   $env:REDIS_URL = 'redis://127.0.0.1:16379/0'       # 会话/协同状态 Redis
#
# 依赖外部服务（docker）：MySQL 33061、Redis 16379（低位固定端口，避开 Windows
# Hyper-V 高位动态保留区；可用 REDIS_URL 覆盖）。日志统一落 .data/dev-server.log
# （logs 子命令实时跟踪）。
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
  [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

# ── 公共配置（对齐 dev-common.sh）───────────────────────────────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $RepoRoot '.data'
$LogFile = Join-Path $DataDir 'dev-server.log'
$PidFile = Join-Path $DataDir 'dev-server.pids'
$Port = if ($env:PORT) { $env:PORT } else { '3001' }
$WebPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '5174' }
if (-not $env:REDIS_URL) { $env:REDIS_URL = 'redis://127.0.0.1:16379/0' }
if (-not $env:API_ORIGIN) { $env:API_ORIGIN = "http://localhost:$Port" }

New-Item -ItemType Directory -Force $DataDir | Out-Null

function Web-Url() { "http://localhost:$WebPort" }
function Api-Url() { "http://localhost:$Port" }

# 端口是否已有监听（Get-NetTCPConnection 优先，netstat 兜底）。
function Test-PortBusy([string]$p) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return [bool](netstat -ano | Select-String ":$p\s.*LISTENING")
  }
}

# 按端口取 LISTENING 的 PID 集（兜底清残留用）。
function Get-PortPids([string]$p) {
  $out = @()
  try {
    $out = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { }
  if ($out.Count -eq 0) {
    $out = @((netstat -ano | Select-String ":$p\s.*LISTENING") | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique)
  }
  return $out
}

function Test-ApiHealthy() {
  try {
    $h = Invoke-RestMethod -Uri "$(Api-Url)/api/health" -TimeoutSec 3
    if (-not $h.ok) { return $false }
    # /api/health 只查 DB；再用无效 token 走一次 Redis 会话查询，预期 401。
    # Redis 不可用时这里会超时或 500，避免误报“健康通过、登录却 500”。
    try {
      Invoke-WebRequest -Uri "$(Api-Url)/api/users/me" -UseBasicParsing -TimeoutSec 3 `
        -Headers @{ Authorization = 'Bearer gmind-dev-readiness-probe' } | Out-Null
      return $false
    } catch {
      $response = $_.Exception.Response
      return [bool]($response -and [int]$response.StatusCode -eq 401)
    }
  } catch {
    return $false
  }
}

# 结束整棵进程树（/T）——pnpm dev 的 server/web 子进程一并清理。
function Stop-Tree([int]$processId) {
  # 进程树清理存在竞争：父进程退出后，taskkill 可能对已退出的子进程报错。
  # 统一吞掉 taskkill 输出/退出码；是否清净由后面的端口复查判定。
  & cmd.exe /d /c "taskkill /PID $processId /T /F >nul 2>&1" | Out-Null
  $global:LASTEXITCODE = 0
}

# ── start ────────────────────────────────────────────────────────────────────
function Start-Dev() {
  if ((Test-PortBusy $Port) -or (Test-PortBusy $WebPort)) {
    Write-Host "[dev] 已在运行：web=$(Web-Url) api=$(Api-Url)（重启请用 dev.ps1 restart）"
    return
  }

  Write-Host "[dev] 启动 server(:$Port) + web(:$WebPort)，日志：.data/dev-server.log"
  # Start-Process 脱离当前会话（关窗/退出终端不影响服务）；环境变量内联传递。
  $inner = @"
`$env:PORT = '$Port'
`$env:WEB_PORT = '$WebPort'
`$env:API_ORIGIN = '$env:API_ORIGIN'
`$env:REDIS_URL = '$env:REDIS_URL'
Set-Location '$RepoRoot'
pnpm dev *> '$LogFile'
"@
  $proc = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList `
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner
  Set-Content -Path $PidFile -Value $proc.Id

  # 等健康（最多 60s：API LISTEN + web LISTEN + /api/health 通过）。
  for ($i = 0; $i -lt 60; $i += 1) {
    if ((Test-PortBusy $Port) -and (Test-PortBusy $WebPort) -and (Test-ApiHealthy)) {
      Write-Host "[dev] 就绪 ✓  web=$(Web-Url)  api=$(Api-Url)（健康检查通过）"
      return
    }
    Start-Sleep -Seconds 1
  }
  Write-Host "[dev] 60s 内未就绪——最近日志："
  Get-Content $LogFile -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}

# ── stop ─────────────────────────────────────────────────────────────────────
function Stop-Dev() {
  # 先按 pid 文件杀整棵进程树（Start-Process 的 pnpm dev 及其 server/web 子进程）。
  if (Test-Path $PidFile) {
    $raw = (Get-Content $PidFile -Raw).Trim()
    if ($raw -match '^\d+$') { Stop-Tree ([int]$raw) }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  # 兜底：Gmind 专用端口（3001/5174）上仍监听的进程一律结束。
  foreach ($p in @($Port, $WebPort)) {
    foreach ($processId in (Get-PortPids $p)) {
      if ($processId -match '^\d+$') { Stop-Tree ([int]$processId) }
    }
  }
  Start-Sleep -Seconds 1
  if ((Test-PortBusy $Port) -or (Test-PortBusy $WebPort)) {
    Write-Host "[dev] 仍有残留监听（$Port/$WebPort），请手动检查：Get-NetTCPConnection -State Listen | ? LocalPort -in $Port,$WebPort"
    exit 1
  }
  Write-Host "[dev] 已停止 ✓"
}

# ── status / logs ────────────────────────────────────────────────────────────
function Show-Status() {
  $webState = if (Test-PortBusy $WebPort) { '运行中' } else { '未启动' }
  $apiState = if (Test-PortBusy $Port) { '运行中' } else { '未启动' }
  Write-Host ("web  {0} : {1}" -f (Web-Url), $webState)
  Write-Host ("api  {0} : {1}" -f (Api-Url), $apiState)
  if (Test-ApiHealthy) { Write-Host '健康检查：通过 ✓' }
  else { Write-Host '健康检查：未通过（服务未起或 DB/Redis 未连）' }
  if (Test-Path $LogFile) {
    Write-Host '—— 日志尾部（.data/dev-server.log）——'
    Get-Content $LogFile -Tail 10
  }
}

function Show-Logs() {
  if (-not (Test-Path $LogFile)) {
    Write-Host '[dev] 还没有日志（先 scripts\dev.ps1 start）'
    return
  }
  Get-Content $LogFile -Wait
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
switch ($Command) {
  'start' { Start-Dev }
  'stop' { Stop-Dev }
  'restart' { Stop-Dev; Start-Dev }
  'status' { Show-Status }
  'logs' { Show-Logs }
}
