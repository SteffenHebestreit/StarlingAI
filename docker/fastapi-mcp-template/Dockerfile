FROM python:3.11-slim

ARG FASTAPI_MCP_TEMPLATE_REPO=https://github.com/SteffenHebestreit/fastapi_mcp_template.git
# Pinned to an immutable commit SHA — NOT the moving `main`. `git clone --branch`
# rejects a SHA and, worse, Docker caches the clone layer so tracking `main` silently
# freezes the image on whatever commit first built (we were stuck a commit behind). The
# fetch-by-SHA below accepts a SHA/tag/branch and a ref bump actually re-fetches. To
# update: bump this to the new upstream HEAD. 958dc13 = "Harden and reshape into a
# file-extraction-for-LLM service" (2026, upstream main HEAD).
ARG FASTAPI_MCP_TEMPLATE_REF=958dc13ec87751694117fe3f5a85b624f539e2b6
ARG ENABLED_TOOLS=file_converter
ARG ENABLE_TESTS=false
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    EXIFTOOL_PATH=/usr/bin/exiftool \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    TOOLS_DIR=/app/tools \
    ENABLED_TOOLS=${ENABLED_TOOLS} \
    ENABLE_TESTS=${ENABLE_TESTS} \
    HOST=0.0.0.0 \
    PORT=8000 \
    FTMD_MARKITDOWN_ENABLE_LLM=false \
    FTMD_OPENAI_BASE_URL=http://host.docker.internal:1234/v1 \
    FTMD_OPENAI_MODEL=qwen3.6-35b-a3b

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    exiftool \
    ffmpeg \
    git \
    libmagic1 \
    libtesseract-dev \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
    tesseract-ocr-fra \
    tesseract-ocr-spa \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Shallow fetch of the exact ref. `git fetch origin <ref>` accepts a commit SHA (GitHub
# allows fetching a reachable SHA), a tag, or a branch — unlike `clone --branch`, which
# rejects a SHA. Mirrors docker/engram/Dockerfile.
RUN git init -q /app \
    && cd /app \
    && git remote add origin "${FASTAPI_MCP_TEMPLATE_REPO}" \
    && git fetch --depth 1 origin "${FASTAPI_MCP_TEMPLATE_REF}" \
    && git checkout -q FETCH_HEAD

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

RUN pip install --no-cache-dir --index-url "${TORCH_INDEX_URL}" torch torchvision

RUN pip install --no-cache-dir -r fastapi_mcp_template/requirements.txt \
    && for tool in $(echo "$ENABLED_TOOLS" | tr ',' ' '); do \
        if [ -f "tools/requirements/${tool}.txt" ]; then \
            echo "Installing dependencies for tool: ${tool}"; \
            pip install --no-cache-dir -r "tools/requirements/${tool}.txt"; \
        fi; \
    done \
    && if [ "$ENABLE_TESTS" = "true" ]; then \
        pip install --no-cache-dir -r fastapi_mcp_template/core_test/requirements.txt; \
    fi

ENV PYTHONPATH=/app

RUN useradd --create-home --shell /bin/bash app \
    && mkdir -p /app/data \
    && chown -R app:app /app

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1

CMD ["python", "fastapi_mcp_template/main.py", "--host", "0.0.0.0", "--port", "8000"]