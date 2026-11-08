<#
.SYNOPSIS
    配置 Cloudflare Tunnel，让 iPad / 外网笔记本用一个固定域名访问本机 Codex Web UI。

.DESCRIPTION
    只在你自己的 Cloudflare 账号 + 自己的域名下工作，出的流量是本机主动外连，
    不需要公网 IP、不需要端口映射、也不需要任何梯子。

    前置（一次性，需要你在浏览器里点一下）：
        cloudflared tunnel login

    然后：
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tunnel.ps1 -Hostname codex.example.com

    之后每天由计划任务自动带起来，域名固定不变。

.EXAMPLE
    # 只是临时给个公网地址（随机域名，重启就变，仅用于试一下）
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-tunnel.ps1 -Quick
#>
[CmdletBinding()]
param(
    [string]$Hostname,
    [string]$TunnelName = 'codex-remote',
    [int]$Port = 8787,
    [switch]$Quick,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$cloudflared = @(
    "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $cloudflared) { throw '找不到 cloudflared.exe，请先安装：winget install --id Cloudflare.cloudflared' }

$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
$configPath = Join-Path $cfDir 'config.yml'
$taskName = 'CodexRemoteTunnel'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "[ok] 已移除计划任务 $taskName" -ForegroundColor Green
    }
    Write-Host '注意：Cloudflare 侧的 tunnel 与 DNS 记录需要到 Zero Trust 面板手动删除。' -ForegroundColor Yellow
    return
}

if ($Quick) {
    Write-Host '启动临时隧道（随机域名，进程退出即失效）…' -ForegroundColor Cyan
    Write-Host '按 Ctrl+C 结束。' -ForegroundColor Yellow
    & $cloudflared tunnel --url "http://127.0.0.1:$Port" --no-autoupdate
    return
}

if (-not $Hostname) {
    throw '请用 -Hostname 指定域名（例如 codex.example.com），或加 -Quick 试用临时隧道。'
}

if (-not (Test-Path (Join-Path $cfDir 'cert.pem'))) {
    Write-Host '还没有登录 Cloudflare。请先执行下面这条命令，并在弹出的浏览器里授权你的域名：' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "    & `"$cloudflared`" tunnel login" -ForegroundColor White
    Write-Host ''
    Write-Host '授权完成后重新运行本脚本。' -ForegroundColor Yellow
    return
}

# 1) 建隧道（已存在则复用）
$existing = (& $cloudflared tunnel list --output json 2>$null | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName }
if ($existing) {
    $tunnelId = $existing.id
    Write-Host "[ok] 复用已有隧道 $TunnelName ($tunnelId)" -ForegroundColor Green
} else {
    & $cloudflared tunnel create $TunnelName | Out-Host
    $existing = (& $cloudflared tunnel list --output json | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName }
    if (-not $existing) { throw '创建隧道失败' }
    $tunnelId = $existing.id
    Write-Host "[ok] 已创建隧道 $TunnelName ($tunnelId)" -ForegroundColor Green
}

# 2) DNS 指向
& $cloudflared tunnel route dns $TunnelName $Hostname | Out-Host

# 3) 写 config.yml（只保留本脚本管理的 ingress）
New-Item -ItemType Directory -Force -Path $cfDir | Out-Null
$yaml = @"
tunnel: $tunnelId
credentials-file: $cfDir\$tunnelId.json

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$Port
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
  - service: http_status:404
"@
Set-Content -Path $configPath -Value $yaml -Encoding ascii
Write-Host "[ok] 已写入 $configPath" -ForegroundColor Green

# 4) 计划任务：登录即带起隧道
$action = New-ScheduledTaskAction -Execute $cloudflared -Argument "tunnel --config `"$configPath`" run $TunnelName --no-autoupdate"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Codex Remote 的 Cloudflare Tunnel 入口' | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ''
Write-Host "[ok] 隧道已注册为登录自启，固定入口： https://$Hostname/" -ForegroundColor Green
Write-Host '     第一次打开会要求输入访问密码（bridge\config.json 里的 passcode）。' -ForegroundColor Cyan
