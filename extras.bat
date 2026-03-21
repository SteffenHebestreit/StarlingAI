@echo off
REM ============================================================
REM  StarlingAI — optional services manager (Windows CMD)
REM
REM  Usage:
REM    extras.bat status              Show status of all optional services
REM    extras.bat pentest on          Start kali-pentest service
REM    extras.bat pentest off         Stop kali-pentest service
REM    extras.bat image on            Start image-generation service
REM    extras.bat image off           Stop image-generation service
REM    extras.bat all on              Start ALL optional services
REM    extras.bat all off             Stop ALL optional services
REM ============================================================

setlocal enabledelayedexpansion

set SERVICE=%1
set ACTION=%2

if "%SERVICE%"=="" set SERVICE=status

REM ── Compose file stack ───────────────────────────────────────────────────────
set COMPOSE=-f docker-compose.yml
if exist docker-compose.strix-halo.yml set COMPOSE=%COMPOSE% -f docker-compose.strix-halo.yml

if "%SERVICE%"=="status"  goto :status
if "%SERVICE%"=="pentest" goto :pentest
if "%SERVICE%"=="image"   goto :image
if "%SERVICE%"=="all"     goto :all
if "%SERVICE%"=="--help"  goto :help
if "%SERVICE%"=="-h"      goto :help

echo ERROR: Unknown service '%SERVICE%'. Use: pentest ^| image ^| all ^| status
exit /b 1

REM ── status ───────────────────────────────────────────────────────────────────
:status
echo.
echo Optional services:
docker compose %COMPOSE% ps kali-pentest image-generation-service 2>nul || echo (none running)
echo.
exit /b 0

REM ── pentest ──────────────────────────────────────────────────────────────────
:pentest
if "%ACTION%"=="on"  goto :pentest_on
if "%ACTION%"=="off" goto :pentest_off
echo ERROR: Usage: extras.bat pentest on^|off
exit /b 1

:pentest_on
echo Starting kali-pentest...
docker compose %COMPOSE% --profile pentest up -d kali-pentest
echo [OK] kali-pentest started
echo [i]  Set PENTEST_SCOPE env var before scanning
goto :status

:pentest_off
echo Stopping kali-pentest...
docker compose %COMPOSE% stop kali-pentest 2>nul
docker compose %COMPOSE% rm -f kali-pentest 2>nul
echo [OK] kali-pentest stopped
goto :status

REM ── image ────────────────────────────────────────────────────────────────────
:image
if "%ACTION%"=="on"  goto :image_on
if "%ACTION%"=="off" goto :image_off
echo ERROR: Usage: extras.bat image on^|off
exit /b 1

:image_on
echo Starting image-generation-service...
docker compose %COMPOSE% --profile image up -d image-generation-service
echo [OK] image-generation-service started (model loading - may take several minutes)
goto :status

:image_off
echo Stopping image-generation-service...
docker compose %COMPOSE% stop image-generation-service 2>nul
docker compose %COMPOSE% rm -f image-generation-service 2>nul
echo [OK] image-generation-service stopped
goto :status

REM ── all ──────────────────────────────────────────────────────────────────────
:all
if "%ACTION%"=="on"  goto :all_on
if "%ACTION%"=="off" goto :all_off
echo ERROR: Usage: extras.bat all on^|off
exit /b 1

:all_on
echo Starting all optional services...
docker compose %COMPOSE% --profile pentest --profile image up -d kali-pentest image-generation-service
echo [OK] All optional services started
echo [i]  Set PENTEST_SCOPE env var before scanning
echo [i]  Image generation model may take several minutes to load
goto :status

:all_off
echo Stopping all optional services...
docker compose %COMPOSE% stop kali-pentest image-generation-service 2>nul
docker compose %COMPOSE% rm -f kali-pentest image-generation-service 2>nul
echo [OK] All optional services stopped
goto :status

REM ── help ─────────────────────────────────────────────────────────────────────
:help
echo.
echo StarlingAI - optional services manager
echo.
echo   extras.bat status         Show status of all optional services
echo   extras.bat pentest on     Start kali-pentest service
echo   extras.bat pentest off    Stop kali-pentest service
echo   extras.bat image on       Start image-generation service
echo   extras.bat image off      Stop image-generation service
echo   extras.bat all on         Start ALL optional services
echo   extras.bat all off        Stop ALL optional services
echo.
exit /b 0
