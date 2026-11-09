# ComfyUI for the `comfyui` profile: the node-graph image engine the comfyui_* tools drive.
#
# Built for an NVIDIA GPU (docker-compose.gpu.yml adds the reservation). Without a visible
# CUDA device the entrypoint starts it on the CPU, which works but is too slow to be useful.
#
# Pinned on purpose: ComfyUI to a release tag, the one custom node to a reviewed commit.
# No ComfyUI-Manager: nothing installs nodes or pulls code at run time. Model files are
# not in the image; fetch_models.py downloads them into the comfyui-models volume.
FROM python:3.13-slim-trixie

ARG COMFYUI_REPO=https://github.com/Comfy-Org/ComfyUI.git
ARG COMFYUI_REF=v0.44.0
# Converts a workflow saved in the ComfyUI editor into the API format /prompt runs.
# Reviewed at this commit: pure data transform (json, logging, aiohttp, ComfyUI's nodes),
# no file, network or process access.
ARG CONVERTER_REPO=https://github.com/SethRobinson/comfyui-workflow-to-api-converter-endpoint.git
ARG CONVERTER_REF=bc8538278f82053b3ca10a44d62d02596f8e1a37
# ComfyUI asks for a cu130 build on NVIDIA 20-series and newer.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu130

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    COMFYUI_DISABLE_PRODUCT_TIPS=1 \
    HF_HUB_DISABLE_TELEMETRY=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install torch torchvision torchaudio --index-url "${TORCH_INDEX_URL}"

RUN git clone --depth 1 --branch "${COMFYUI_REF}" "${COMFYUI_REPO}" /opt/comfyui \
    && pip install -r /opt/comfyui/requirements.txt \
    && git init -q /opt/comfyui/custom_nodes/workflow-to-api-converter \
    && cd /opt/comfyui/custom_nodes/workflow-to-api-converter \
    && git remote add origin "${CONVERTER_REPO}" \
    && git fetch -q --depth 1 origin "${CONVERTER_REF}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf .git /opt/comfyui/.git

# Triton compiles small kernels at run time and needs a C compiler for them: without one the
# int8 models' text encoder fails on the first run ("Failed to find C compiler").
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh fetch_models.py models.json /opt/starlingai/

RUN useradd --create-home --uid 1000 comfy \
    && mkdir -p /data/output /data/input /data/user /opt/comfyui/models/.downloads /opt/comfyui/temp \
    && chown -R comfy:comfy /data /opt/comfyui/models /opt/comfyui/custom_nodes /opt/comfyui/temp \
    && chmod 0755 /opt/starlingai/entrypoint.sh

USER comfy
WORKDIR /opt/comfyui
EXPOSE 8188
VOLUME ["/opt/comfyui/models", "/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8188/system_stats', timeout=8); sys.exit(0)" || exit 1

ENTRYPOINT ["/opt/starlingai/entrypoint.sh"]
