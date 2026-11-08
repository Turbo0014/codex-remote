<#
.SYNOPSIS
    注册 / 更新 Codex Remote 桥接服务的登录自启（计划任务）。

.DESCRIPTION
    在「用户登录时」拉起 scripts\start-bridge.vbs，由它无窗口启动 bridge\server.mjs。
    任务会常驻，失败自动重启；不写入任何系统级服务，卸载只需一条命令。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = 'CodexRemoteBridge'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'start-bridge.vbs'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[ok] 已移除计划任务 $TaskName" -ForegroundColor Green
    } else {
        Write-Host "[--] 计划任务 $TaskName 不存在" -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $vbs)) { throw "找不到 $vbs" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Codex Remote 桥接：把本机 Codex 暴露成局域网/隧道可访问的 Web UI' | Out-Null

Write-Host "[ok] 已注册计划任务 $TaskName（登录时自动启动）" -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host

Write-Host '立即启动一次：' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/healthz' -UseBasicParsing -TimeoutSec 6
    Write-Host "[ok] 健康检查 $($r.StatusCode): $($r.Content)" -ForegroundColor Green
} catch {
    Write-Host "[!!] 健康检查失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "     看日志：$root\bridge\logs\bridge.log" -ForegroundColor Yellow
}
