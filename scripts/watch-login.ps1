<#
.SYNOPSIS
    等待 Tailscale 登录完成，然后自动把本机 Codex Web UI 配成 tailnet 内的 HTTPS 入口。

.DESCRIPTION
    由后台任务运行，最多等 15 分钟。登录成功后：
      1. tailscale serve --bg 8787     （HTTPS 反向代理到 bridge，证书由 Tailscale 自动签发）
      2. 把可访问地址写到 docs\tailnet-url.txt
    失败时会退回「直接用 http://100.x.y.z:8787」并在结果里说明。
#>
$ErrorActionPreference = 'Continue'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$root = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $root 'docs\tailnet-url.txt'
$deadline = (Get-Date).AddMinutes(15)

function Write-Result([string]$text) {
    Set-Content -Path $outFile -Value $text -Encoding UTF8
    Write-Output $text
}

if (-not (Test-Path $ts)) { Write-Result 'ERROR: tailscale.exe not found'; exit 1 }

Write-Output 'watching for login...'
$state = ''
while ((Get-Date) -lt $deadline) {
    $json = & $ts status --json 2>$null
    if ($json) {
        try { $st = $json | ConvertFrom-Json } catch { $st = $null }
        if ($st) {
            $state = $st.BackendState
            if ($state -eq 'Running') { break }
        }
    }
    Start-Sleep -Seconds 5
}

if ($state -ne 'Running') {
    Write-Result "TIMEOUT: backend still '$state' after 15 minutes"
    exit 1
}

$ip = (& $ts ip -4 2>$null | Select-Object -First 1)
$dns = ((& $ts status --json 2>$null) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
Write-Output "logged in: ip=$ip dns=$dns"

# Serve the bridge over HTTPS inside the tailnet (no port forwarding, real cert).
$serveOk = $false
$serveOut = ''
foreach ($args in @(
    @('serve', '--bg', 'http://127.0.0.1:8787'),
    @('serve', '--bg', '--https=443', 'http://127.0.0.1:8787'),
    @('serve', '--bg', '8787')
)) {
    $serveOut = (& $ts @args 2>&1 | Out-String)
    Write-Output "serve $($args -join ' ') -> $serveOut"
    if ($serveOut -match 'Available at|https://') { $serveOk = $true; break }
    if ($LASTEXITCODE -eq 0) { $serveOk = $true; break }
}

$urls = [regex]::Matches($serveOut, 'https://[^\s]+') | ForEach-Object { $_.Value } | Select-Object -Unique

if ($serveOk -and $urls) {
    Write-Result ("OK`nHTTPS: " + ($urls -join ' / ') + "`nHTTP : http://${ip}:8787`nDNS : $dns")
} elseif ($dns) {
    Write-Result ("PARTIAL`nHTTPS not configured (see serve output)`nHTTP : http://${ip}:8787`nDNS : $dns`nSERVE: $serveOut")
} else {
    Write-Result ("PARTIAL`nHTTP : http://${ip}:8787")
}
