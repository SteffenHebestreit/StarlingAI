@echo off
REM ============================================================
REM  StarlingAI — one-command start script (Windows CMD)
REM
REM  Usage:
REM    start.bat                   Build (if needed) + start core services
REM    start.bat --build           Force rebuild, then start
REM    start.bat --no-cache        Force rebuild with no Docker cache
REM    start.bat --fresh           Wipe volumes + rebuild + start (clean slate)
REM    start.bat --pentest         Also start the kali-pentest service
REM    start.bat --image           Also start the image-generation service
REM    start.bat --down            Stop all services
REM
REM  For WSL/Git Bash users: use start.sh instead.
REM ============================================================

setlocal enabledelayedexpansion

set BUILD=0
set NO_CACHE=0
set FRESH=0
set PENTEST=0
set IMAGE_GEN=0
set DOWN=0
set PROFILES=

for %%a in (%*) do (
    if "%%a"=="--build"     set BUILD=1
    if "%%a"=="--no-cache"  set BUILD=1 & set NO_CACHE=1
    if "%%a"=="--fresh"     set BUILD=1 & set NO_CACHE=1 & set FRESH=1
    if "%%a"=="--pentest"   set PENTEST=1
    if "%%a"=="--image"     set IMAGE_GEN=1
    if "%%a"=="--down"      set DOWN=1
)

if %PENTEST%==1  set PROFILES=%PROFILES% --profile pentest
if %IMAGE_GEN%==1 set PROFILES=%PROFILES% --profile image

REM ── Down mode ────────────────────────────────────────────────────────────────
if %DOWN%==1 (
    echo Stopping StarlingAI...
    docker compose --profile pentest --profile image down
    echo Done.
    exit /b 0
)

echo.
echo *** StarlingAI — Starting up ***
echo.

REM ── Check Docker ─────────────────────────────────────────────────────────────
docker --version >nul 2>&1 || (echo ERROR: Docker not found. Install Docker Desktop. & exit /b 1)
docker compose version >nul 2>&1 || (echo ERROR: Docker Compose not found. & exit /b 1)
echo [OK] Docker available

REM ── Check .env ───────────────────────────────────────────────────────────────
if not exist .env (
    echo [WARN] .env not found. Running setup...
    node scripts\setup.mjs || (echo ERROR: Setup failed. Copy .env.example to .env and fill in secrets. & exit /b 1)
)
echo [OK] .env present

REM ── Check starlingai.json ─────────────────────────────────────────────────────
if not exist starlingai.json (
    echo ERROR: starlingai.json not found. Copy starlingai.example.json and configure it.
    exit /b 1
)
echo [OK] starlingai.json present

REM ── Fresh wipe ───────────────────────────────────────────────────────────────
if %FRESH%==1 (
    echo Wiping volumes...
    docker compose --profile pentest --profile image down -v
    echo [OK] Volumes wiped
)

REM ── Build ─────────────────────────────────────────────────────────────────────
if %BUILD%==1 (
    echo Building images...
    if %NO_CACHE%==1 (
        docker compose %PROFILES% build --no-cache
    ) else (
        docker compose %PROFILES% build
    )
    echo [OK] Images built
) else (
    docker image inspect starlingai/gateway:dev >nul 2>&1 || (
        echo First run — building images...
        docker compose %PROFILES% build
        echo [OK] Images built
    )
)

REM ── Start ─────────────────────────────────────────────────────────────────────
echo Starting services...
docker compose %PROFILES% up -d
echo [OK] Services started

REM ── Status ───────────────────────────────────────────────────────────────────
echo.
echo Waiting 20 seconds for services to come up...
timeout /t 20 /nobreak >nul

echo.
docker compose %PROFILES% ps
echo.

REM ── Token ────────────────────────────────────────────────────────────────────
echo Dashboard login token:
node scripts\gen-token.mjs 2>nul || echo (Run: node scripts\gen-token.mjs)

echo.
echo *** StarlingAI is running ***
echo.
echo   Dashboard     -^>  http://localhost:3001
echo   Tutorials     -^>  http://localhost:3002
echo   Gateway API   -^>  http://localhost:8765/api
echo   Health        -^>  http://localhost:8765/healthz
echo.
echo   Stop:  start.bat --down
echo   Logs:  docker compose logs -f
echo.
