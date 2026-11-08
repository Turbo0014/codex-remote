# Convert an Office document to PDF using the installed Office COM servers.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File office-to-pdf.ps1 -In <src> -Out <dst.pdf>
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$ext = [System.IO.Path]::GetExtension($In).ToLowerInvariant()
$app = $null
$doc = $null

function Release($o) {
  if ($o -ne $null) {
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null } catch {}
  }
}

try {
  switch ($ext) {
    { $_ -in '.pptx', '.ppt', '.odp', '.ppsx', '.pps' } {
      $app = New-Object -ComObject PowerPoint.Application
      $doc = $app.Presentations.Open($In, $true, $false, $true)
      $doc.SaveAs($Out, 32)   # ppSaveAsPDF
      break
    }
    { $_ -in '.docx', '.doc', '.rtf', '.odt' } {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $doc = $app.Documents.Open($In, $false, $true)
      $doc.SaveAs([ref]$Out, [ref]17)   # wdFormatPDF
      break
    }
    { $_ -in '.xlsx', '.xls', '.ods', '.csv' } {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $doc = $app.Workbooks.Open($In, 0, $true)
      $doc.ExportAsFixedFormat(0, $Out)  # xlTypePDF
      break
    }
    default { throw "unsupported extension $ext" }
  }
  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }
  if ($app -ne $null) { try { $app.Quit() } catch {} }
  Write-Output 'ok'
}
catch {
  try { if ($doc -ne $null) { $doc.Close($false) } } catch {}
  try { if ($app -ne $null) { $app.Quit() } } catch {}
  Write-Output ('error: ' + $_.Exception.Message)
  exit 1
}
finally {
  Release $doc
  Release $app
  [GC]::Collect()
}
