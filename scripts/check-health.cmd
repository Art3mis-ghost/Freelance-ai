@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-health.ps1" %*
exit /b %ERRORLEVEL%
