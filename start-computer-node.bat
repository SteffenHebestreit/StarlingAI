@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\computer-node-host.ps1" start
exit /b %ERRORLEVEL%