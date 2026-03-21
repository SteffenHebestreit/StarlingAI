FROM python:3.11-slim

ARG FASTAPI_MCP_TEMPLATE_REPO=https://github.com/SteffenHebestreit/fastapi_mcp_template.git
ARG FASTAPI_MCP_TEMPLATE_REF=main
ARG ENABLED_TOOLS=file_converter
ARG ENABLE_TESTS=false

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
    FTMD_OPENAI_MODEL=qwen/qwen3.5-35b-a3b

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

RUN git clone --depth 1 --branch "${FASTAPI_MCP_TEMPLATE_REF}" "${FASTAPI_MCP_TEMPLATE_REPO}" /app

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

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