# Removes the Store POS program and shortcuts. Your data in %APPDATA%\Store POS is KEPT.
Get-Process -Name 'Store POS' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Store POS.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Store POS') -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'electron.app.Store POS' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Store POS' -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\.posupdate' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Classes\StorePOS.Update' -Recurse -Force -ErrorAction SilentlyContinue
Set-Location $env:TEMP
Remove-Item (Join-Path $env:LOCALAPPDATA 'Programs\Store POS') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Store POS was removed. Your sales data and backups are still in' (Join-Path $env:APPDATA 'Store POS')
Start-Sleep -Seconds 4
