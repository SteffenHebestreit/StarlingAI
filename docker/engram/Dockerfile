# engram graph-RAG service — built from the upstream repo, run against the
# project's Neo4j (with GDS), LM Studio embeddings/LLM, and the TEI reranker.
# Mirrors the docker/fastapi-mcp-template pattern: clone a pinned ref + install.
FROM python:3.12-slim AS base

ARG ENGRAM_REPO=https://github.com/SteffenHebestreit/engram.git
# Pinned to an immutable ref (a commit SHA, or a release tag) — NOT the moving `main` —
# so the build is reproducible AND a bump actually re-clones (Docker caches the fetch layer,
# so tracking `main` would silently freeze on whatever version first built). The fetch below
# accepts a SHA, tag, or branch. To update engram: bump this to the new SHA/tag (or pass
# --build-arg ENGRAM_REF=…); prefer a release tag once one is cut.
#
# Currently pinned to a post-v0.5.0 `main` commit that adds the SEPARATE fast extraction model
# path (EXTRACTION_LLM_MODEL/_API_BASE/_MAX_TOKENS/_MIN_CHARS), EXTRACTION_RESPONSE_FORMAT
# (json_schema = guaranteed-valid JSON + reasoning suppression on LM Studio), EXTRACTION_EXTRA_BODY
# (serving-specific reasoning controls), and flips METADATA_EXTRACTOR's default to `yake`.
# API+env compatible with our client; the new fields fall back to today's behaviour when unset.
ARG ENGRAM_REF=d81a488295c2443a9de42b98d411634207c3dd3d

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

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]
