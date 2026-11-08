<#
.SYNOPSIS
    以「非提权」身份运行一条命令，并把输出写到文件。

.DESCRIPTION
    Codex 的共享 app-server daemon 明确拒绝从提权终端启动（否则所有共享客户端都会
    继承管理员权限）。这个脚本用「RunLevel Limited」的计划任务把命令降到普通用户令牌
    再执行，从而复现桌面端／普通终端下的行为。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-as-limited.ps1 -CommandFile .\probe.cmd -LogFile .\probe.log
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CommandFile,
    [string]$LogFile = "$env:TEMP\limited-run.log",
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$CommandFile = (Resolve-Path $CommandFile).Path
$LogFile = [System.IO.Path]::GetFullPath($LogFile)
$done = "$LogFile.done"
Remove-Item $LogFile, $done -Force -ErrorAction SilentlyContinue

$runner = Join-Path $env:TEMP "limited-$([guid]::NewGuid().ToString('N')).cmd"
$body = @"
@echo off
call "$CommandFile" > "$LogFile" 2>&1
echo EXIT=%ERRORLEVEL% >> "$LogFile"
echo done > "$done"
"@
Set-Content -Path $runner -Value $body -Encoding ascii

$taskName = "CodexLimitedRun-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null

try {
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $done)) { Start-Sleep -Milliseconds 400 }
    if (-not (Test-Path $done)) { Write-Output "[timeout after $TimeoutSeconds s]" }
    if (Test-Path $LogFile) { Get-Content $LogFile -Raw } else { Write-Output '(no output file)' }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item $runner -Force -ErrorAction SilentlyContinue
}
