@echo off
title Install Store POS
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (echo. & echo Install failed. See the message above. & pause)
