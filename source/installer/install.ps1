# Store POS installer — copies the app to this PC and makes shortcuts.
# Your data (items, sales, settings) lives separately in %APPDATA%\Store POS and is never touched by installing or updating.
$ErrorActionPreference = 'Stop'
$src  = Join-Path $PSScriptRoot 'app'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Store POS'
$exe  = Join-Path $dest 'Store POS.exe'
$icon = Join-Path $dest 'resources\app\icon.ico'
Write-Host ''
Write-Host '  Installing Store POS...' -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $src 'Store POS.exe'))) { throw "The 'app' folder is missing. Extract the whole zip first, then run Install again." }
Get-Process -Name 'Store POS' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
Get-ChildItem $dest -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($path) {
  $s = $shell.CreateShortcut($path); $s.TargetPath = $exe; $s.WorkingDirectory = $dest
  $s.IconLocation = "$icon,0"; $s.Description = 'Store POS'; $s.Save()
}
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Store POS.lnk')
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Store POS'
New-Item -ItemType Directory -Path $menu -Force | Out-Null
New-Shortcut (Join-Path $menu 'Store POS.lnk')
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $dest -Force
$u = $shell.CreateShortcut((Join-Path $menu 'Uninstall Store POS.lnk'))
$u.TargetPath = 'powershell.exe'; $u.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$dest\uninstall.ps1`""; $u.Save()
# Double-clicking a .posupdate file installs it in Store POS
$cls = 'HKCU:\Software\Classes'
New-Item -Path "$cls\.posupdate" -Force | Out-Null
Set-Item -Path "$cls\.posupdate" -Value 'StorePOS.Update'
New-Item -Path "$cls\StorePOS.Update\DefaultIcon" -Force | Out-Null
Set-Item -Path "$cls\StorePOS.Update" -Value 'Store POS update'
Set-Item -Path "$cls\StorePOS.Update\DefaultIcon" -Value "$icon,0"
New-Item -Path "$cls\StorePOS.Update\shell\open\command" -Force | Out-Null
Set-Item -Path "$cls\StorePOS.Update\shell\open\command" -Value "`"$exe`" `"%1`""
Write-Host '  Done! Starting Store POS...' -ForegroundColor Green
Start-Process -FilePath $exe -WorkingDirectory $dest
Start-Sleep -Seconds 2
