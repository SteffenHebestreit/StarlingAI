@echo off
setlocal
node "%~dp0scripts\sai.mjs" %*
exit /b %ERRORLEVEL%