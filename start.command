#!/usr/bin/env bash
# StarlingAI one-click launcher (macOS). Double-click this file in Finder.
# (If macOS blocks it the first time: right-click → Open, or run
#  `chmod +x start.command` once.) Only prerequisite: Docker Desktop.
cd "$(dirname "$0")"
exec ./start.sh "$@"
