$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
Write-Host ""
Write-Host "=== PdfStudio license key generator ===" -ForegroundColor Cyan
Write-Host ""
$name = Read-Host "Customer name (who is this key for)"
if (-not $name.Trim()) { Write-Host "A name is required." -ForegroundColor Red; Read-Host "Press Enter to close"; exit }
$mid = Read-Host "Customer's Computer ID (shown on their activation screen; leave blank = works on ANY PC)"
$days = Read-Host "Expires after how many days? (leave blank = never expires)"
$args2 = @('scripts/keygen.mjs','issue','--name',$name.Trim())
if ($mid.Trim()) { $args2 += @('--machine',$mid.Trim()) }
if ($days.Trim()) { $args2 += @('--days',$days.Trim()) }
$out = & node @args2
$key = ($out | Where-Object { $_ -like 'PDFS-*' } | Select-Object -First 1)
if (-not $key) { Write-Host ($out -join "`n") -ForegroundColor Red; Read-Host "Press Enter to close"; exit }
Set-Clipboard -Value $key
Write-Host ""
Write-Host $key -ForegroundColor Green
Write-Host ""
Write-Host ($out | Where-Object { $_ -like 'Licensed to:*' })
Write-Host ""
Write-Host "The key has been COPIED to your clipboard. Paste it into an email or message to the customer." -ForegroundColor Yellow
Write-Host "(Also saved in keys\issued.log)"
Write-Host ""
Read-Host "Press Enter to close"
