@echo off
REM Deprecated — use: pnpm sai start [flags]
echo WARNING: start.bat is deprecated. Use: pnpm sai start %* >&2
node scripts/sai.mjs start %*
