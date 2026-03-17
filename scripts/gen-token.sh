#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Load SAI_JWT_SECRET from .env if it exists
if [ -f "$ENV_FILE" ]; then
  SAI_JWT_SECRET=$(grep '^SAI_JWT_SECRET=' "$ENV_FILE" | cut -d'=' -f2-)
  export SAI_JWT_SECRET
fi

docker run --rm \
  -v "$HOME/.starlingai:/root/.starlingai" \
  -v "$SCRIPT_DIR/gen-token.mjs:/app/gen-token.mjs" \
  -e "SAI_JWT_SECRET=${SAI_JWT_SECRET:-}" \
  -e "SAI_CONFIG_PATH=${SAI_CONFIG_PATH:-}" \
  node:22-alpine \
  sh -c "cd /app && echo '{\"type\":\"module\",\"dependencies\":{\"jose\":\"^6.0.0\",\"json5\":\"^2.2.3\"}}' > package.json && npm install --silent 2>/dev/null && node gen-token.mjs $*"
