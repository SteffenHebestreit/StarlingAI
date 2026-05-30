@echo off
REM StarlingAI one-click launcher (Windows). Double-click this file.
REM The only prerequisite is Docker Desktop — setup runs guided, inside Docker.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
