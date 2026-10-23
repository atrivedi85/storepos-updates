# Rejoins the StorePOS-Setup-1.3.0.zip.00x pieces, checks them, unzips and runs the installer.
$ErrorActionPreference = 'Stop'
$name = 'StorePOS-Setup-1.3.0.zip'
$expected = '26131e2559a43c03263209195c2c6c03556df1b371d22a288e86648f352611fe'
$work = Join-Path $env:TEMP 'StorePOS-Setup'
Write-Host ''
Write-Host '  Joining installer pieces...' -ForegroundColor Cyan
$parts = Get-ChildItem -Path $PSScriptRoot -Filter "$name.*" | Sort-Object Name
if ($parts.Count -lt 6) { throw "Expected 6 pieces ($name.001 to .006), found $($parts.Count)." }
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zip = Join-Path $work $name
$out = [IO.File]::Create($zip)
foreach ($p in $parts) { $in = [IO.File]::OpenRead($p.FullName); $in.CopyTo($out); $in.Close() }
$out.Close()
Write-Host '  Checking the file...' -ForegroundColor Cyan
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $expected) { throw 'The installer pieces are damaged or incomplete. Copy them again from the NAS.' }
Write-Host '  Unzipping...' -ForegroundColor Cyan
Expand-Archive -Path $zip -DestinationPath $work -Force
& (Join-Path $work 'Store POS Setup\install.ps1')
