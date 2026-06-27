# engram graph-RAG service — built from the upstream repo, run against the
# project's Neo4j (with GDS), LM Studio embeddings/LLM, and the TEI reranker.
# Mirrors the docker/fastapi-mcp-template pattern: clone a pinned ref + install.
FROM python:3.12-slim AS base

ARG ENGRAM_REPO=https://github.com/SteffenHebestreit/engram.git
# Pinned to a release tag (not the moving `main`) so the build is reproducible AND so a
# bump actually re-clones — Docker caches the `git clone` layer, so tracking `main` would
# silently freeze on whatever version first built. To update engram: bump this to the new
# tag (or pass --build-arg ENGRAM_REF=…). v0.2.0 is API+env compatible with our client
# (POST /documents, POST /search tuning.final_top_k, GET/DELETE /documents, source scoping).
ARG ENGRAM_REF=v0.2.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PORT=8088

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/engram

RUN git clone --depth 1 --branch "${ENGRAM_REF}" "${ENGRAM_REPO}" /tmp/engram \
    && cp -a /tmp/engram/. /srv/engram/ \
    && rm -rf /tmp/engram

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8088/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]
