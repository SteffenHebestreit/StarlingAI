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
# Pinned to the v0.9.0 release tag: adds the read-side `sources` document-level
# scope filter on POST /search + the MCP search tool — what
# retrieval.documentRag.serverSideScopeFilter consumes (docs/
# engram-sources-filter-spec.md). Everything from v0.8.0 is included: app→engram
# rename (CMD below = the upstream Dockerfile's canonical entrypoint), the v0.6.0
# agent-memory pivot (tenant_id scope-sets, invalidation, retrieval confidence,
# near-dup contradiction guard), the v0.7.0 restructure (explicit STORE_BACKEND
# still wins over ENGRAM_MODE; PPR removed; HYDE default off). Rollback ref = v0.8.0.
ARG ENGRAM_REF=v0.9.0

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
