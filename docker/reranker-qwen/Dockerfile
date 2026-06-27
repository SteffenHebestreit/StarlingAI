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

COPY app.py ./

EXPOSE 8091
# single worker: the model is held in-process and not fork-safe to duplicate
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
