#!/usr/bin/env bash
# Deprecated — use: pnpm sai start [flags]
echo -e "\033[33m⚠ start.sh is deprecated. Use: pnpm sai start $*\033[0m" >&2
exec node scripts/sai.mjs start "$@"
