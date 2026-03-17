@echo off
setlocal

set SCRIPT_DIR=%~dp0
set ENV_FILE=%SCRIPT_DIR%..\\.env

:: Load SAI_JWT_SECRET from .env if it exists
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if "%%A"=="SAI_JWT_SECRET" set "SAI_JWT_SECRET=%%B"
  )
)

docker run --rm ^
  -v "%USERPROFILE%\.starlingai:/root/.starlingai" ^
  -v "%SCRIPT_DIR%gen-token.mjs:/app/gen-token.mjs" ^
  -e "SAI_JWT_SECRET=%SAI_JWT_SECRET%" ^
  -e "SAI_CONFIG_PATH=%SAI_CONFIG_PATH%" ^
  node:22-alpine ^
  sh -c "cd /app && echo '{\"type\":\"module\",\"dependencies\":{\"jose\":\"^6.0.0\",\"json5\":\"^2.2.3\"}}' > package.json && npm install --silent 2>/dev/null && node gen-token.mjs %*"
