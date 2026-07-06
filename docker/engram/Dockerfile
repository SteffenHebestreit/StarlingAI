# engram agent-memory / document-RAG service — built from the upstream repo, run
# against the embedded engramdb store, the primary model server's embeddings/LLM,
# and the shared TEI-format reranker sidecar.
# Mirrors the docker/fastapi-mcp-template pattern: clone a pinned ref + install.
FROM python:3.12-slim AS base

ARG ENGRAM_REPO=https://github.com/SteffenHebestreit/engram.git
# Pinned to an immutable ref (a commit SHA, or a release tag) — NOT the moving `main` —
# so the build is reproducible AND a bump actually re-clones (Docker caches the fetch layer,
# so tracking `main` would silently freeze on whatever version first built). The fetch below
# accepts a SHA, tag, or branch. To update engram: bump this to the new SHA/tag (or pass
# --build-arg ENGRAM_REF=…). NOTE: upstream git TAGS are the version truth — the GitHub
# Releases page and the API's own version string lag behind them.
#
# v0.8.0 ("name-complete"): package renamed app→engram (CMD below tracks the upstream
# Dockerfile's canonical `engram.interfaces.main:app`). Carries the v0.6.0 agent-memory
# pivot (tenant_id scope-sets, POST /documents/{id}/invalidate, top_rerank_score/score_gap
# retrieval confidence, near-dup contradiction guard) and the v0.7.0 3-layer restructure
# (ENGRAM_MODE; an explicitly-set STORE_BACKEND still wins; PPR removed; HYDE_ENABLED now
# defaults FALSE per upstream's own no-measured-lift benchmarks). The HTTP request/response
# contract of the five endpoints our client calls is unchanged; rollback ref =
# d81a488295c2443a9de42b98d411634207c3dd3d (the previous post-v0.5.0 pin).
ARG ENGRAM_REF=v0.8.0

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

# Shallow fetch of the exact ref. `git fetch origin <ref>` accepts a commit SHA (GitHub allows
# fetching a reachable SHA), a tag, or a branch — unlike `clone --branch`, which rejects a SHA.
RUN git init -q /srv/engram \
    && cd /srv/engram \
    && git remote add origin "${ENGRAM_REPO}" \
    && git fetch --depth 1 origin "${ENGRAM_REF}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf /srv/engram/.git

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8088/health')" || exit 1

CMD ["uvicorn", "engram.interfaces.main:app", "--host", "0.0.0.0", "--port", "8088"]
