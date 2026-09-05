# Qwen3 model sidecar for engram — vendored from upstream engram deploy/reranker
# (github.com/SteffenHebestreit/engram, v0.5.0) and extended with /v1/embeddings.
# Serves a causal-LM reranker (Qwen3-Reranker-0.6B) in engram's reranker wire format
# (tei + jina) — which TEI's classifier endpoint can't do — and, when EMBED_MODEL_NAME
# is set, Qwen3-Embedding-0.6B at an OpenAI-compatible /v1/embeddings. docker-compose
# runs it on the host GPU (USE_FP16=true); CPU also works for the 0.6B models.
FROM python:3.12-slim

WORKDIR /srv/reranker

# torch (a sentence-transformers dep) is large; install deps first so it caches
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# On a CUDA host, transformers' Qwen3 forward pass reaches triton, which JIT-compiles a
# small CUDA helper at first use and needs a C compiler to do it. python:3.12-slim ships
# none, so every /rerank answered 500 ("Failed to find C compiler") while /health — which
# never touches the model — stayed green. After the pip layer, so the torch download
# stays cached.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

COPY app.py ./

EXPOSE 8091
# single worker: the model is held in-process and not fork-safe to duplicate
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
