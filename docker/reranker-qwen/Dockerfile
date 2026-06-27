# Qwen3-Reranker sidecar for engram — vendored from upstream engram deploy/reranker
# (github.com/SteffenHebestreit/engram, v0.5.0). Serves a causal-LM reranker
# (Qwen3-Reranker-0.6B) in engram's reranker wire format (tei + jina), which TEI's
# classifier endpoint can't do. CPU by default (fine for the 0.6B on small shortlists);
# for the 4B/8B build FROM an nvidia/cuda + torch base and set USE_FP16=true.
FROM python:3.12-slim

WORKDIR /srv/reranker

# torch (a sentence-transformers dep) is large; install deps first so it caches
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8091
# single worker: the model is held in-process and not fork-safe to duplicate
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
