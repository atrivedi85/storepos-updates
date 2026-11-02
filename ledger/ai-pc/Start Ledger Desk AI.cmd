@echo off
title Ledger Desk AI
set "D=%LOCALAPPDATA%\Programs\Ledger Desk Server"
echo.
echo   Starting Ledger Desk AI (connects this PC's AI to trivedipos.com/books)...
rem stop an older copy of Ledger Desk AI (Ledger Desk Server itself keeps running)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='Ledger Desk Server.exe'\" | Where-Object { $_.CommandLine -like '*ledger-desk-ai.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
rem start it every time Windows starts
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Ledger Desk AI.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%D%\ledger-ai\run-ai.vbs\"'; $s.WorkingDirectory='%D%\ledger-ai'; $s.Save()"
wscript "%D%\ledger-ai\run-ai.vbs"
timeout /t 8 /nobreak >nul
echo.
type "%D%\ledger-ai\ledger-desk-ai.log" 2>nul
echo.
echo   Done. Ledger Desk AI now starts by itself whenever Windows starts.
echo   You can close this window.
echo.
pause
