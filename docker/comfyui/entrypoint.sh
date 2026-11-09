#!/bin/sh
# Starts ComfyUI for the comfyui profile. Missing model files are fetched in the
# background, so the server answers at once and each model appears when its download ends.
set -e

DEVICE_ARGS=""
if ! python -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
    echo "[comfyui] no CUDA device visible: starting on the CPU (slow)"
    DEVICE_ARGS="--cpu"
fi

if [ "${COMFYUI_FETCH_MODELS:-1}" != "0" ]; then
    python /opt/starlingai/fetch_models.py &
fi

# --offline: no paid partner nodes, and the editor fetches nothing from the internet.
# shellcheck disable=SC2086
exec python /opt/comfyui/main.py \
    --listen 0.0.0.0 --port 8188 \
    --disable-auto-launch --offline \
    --output-directory /data/output \
    --input-directory /data/input \
    --user-directory /data/user \
    $DEVICE_ARGS ${COMFYUI_EXTRA_ARGS:-}
