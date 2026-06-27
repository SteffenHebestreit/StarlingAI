"""Qwen3 model sidecar for engram + the gateway. Serves a sentence-transformers
CrossEncoder reranker in engram's reranker wire format (tei + jina) and, when
EMBED_MODEL_NAME is set, an OpenAI-compatible embeddings endpoint. Vendored from
upstream engram deploy/reranker (github.com/SteffenHebestreit/engram, v0.5.0) and
extended here with /v1/embeddings.

Qwen3-Reranker is a causal-LM reranker, so TEI's classifier rerank endpoint can't
serve it and LM Studio exposes no /rerank endpoint at all — this sidecar loads it via
sentence-transformers CrossEncoder (proper logit-based yes/no scoring → continuous
relevance). With EMBED_MODEL_NAME set it ALSO serves Qwen3-Embedding-0.6B via a
SentenceTransformer, so engram embeds on the host GPU instead of depending on a remote
LM Studio. Both models share the one container + GPU.

  RERANKER_API_BASE=http://reranker:80
  RERANKER_MODEL=Qwen/Qwen3-Reranker-0.6B
  RERANKER_FORMAT=tei                          # this sidecar speaks both "tei" and "jina"
  EMBEDDING_API_BASE=http://reranker:80/v1     # OpenAI-compatible embeddings
  EMBED_MODEL_NAME=Qwen/Qwen3-Embedding-0.6B

Endpoints:
  POST /rerank  {"query", "texts": [...]}                 -> [{"index", "score"}]            (tei)
  POST /rerank  {"query", "documents": [...], "top_n"?}   -> {"results": [{"index","relevance_score"}]} (jina)
  POST /v1/embeddings (also /embeddings)  {"input": str|[str], "model"?}
        -> {"object":"list","data":[{"embedding","index"}],"model","usage"}                  (OpenAI)

Both models load lazily on first request so the container starts fast and a readiness
probe can gate it. MODEL_NAME / EMBED_MODEL_NAME / USE_FP16 / MAX_LENGTH are env-tunable.
"""

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_NAME = os.environ.get("MODEL_NAME", "Qwen/Qwen3-Reranker-0.6B")
EMBED_MODEL_NAME = os.environ.get("EMBED_MODEL_NAME", "")
EMBED_NORMALIZE = os.environ.get("EMBED_NORMALIZE", "true").lower() == "true"
USE_FP16 = os.environ.get("USE_FP16", "true").lower() == "true"
MAX_LENGTH = int(os.environ.get("MAX_LENGTH", "512"))

app = FastAPI(title="engram qwen reranker + embedding sidecar")
_model = None
_embed_model = None


def model():
    """Load the CrossEncoder reranker once, on first use (keeps startup cheap)."""
    global _model
    if _model is None:
        import torch
        from sentence_transformers import CrossEncoder

        kwargs = {"max_length": MAX_LENGTH}
        if USE_FP16 and torch.cuda.is_available():
            kwargs["model_kwargs"] = {"torch_dtype": torch.float16}
        _model = CrossEncoder(MODEL_NAME, **kwargs)
    return _model


def embed_model():
    """Load the SentenceTransformer embedder once, on first use."""
    global _embed_model
    if _embed_model is None:
        if not EMBED_MODEL_NAME:
            raise HTTPException(
                status_code=503, detail="embeddings disabled (EMBED_MODEL_NAME unset)"
            )
        import torch
        from sentence_transformers import SentenceTransformer

        kwargs = {}
        if torch.cuda.is_available():
            kwargs["device"] = "cuda"
            if USE_FP16:
                kwargs["model_kwargs"] = {"torch_dtype": torch.float16}
        _embed_model = SentenceTransformer(EMBED_MODEL_NAME, **kwargs)
    return _embed_model


class RerankRequest(BaseModel):
    query: str
    # tei callers send `texts`; jina callers send `documents` — accept either
    texts: list[str] | None = None
    documents: list[str] | None = None
    model: str | None = None
    top_n: int | None = None


class EmbeddingRequest(BaseModel):
    # OpenAI embeddings: `input` is a string or an array of strings
    input: str | list[str]
    model: str | None = None


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "loaded": _model is not None,
        "embed_model": EMBED_MODEL_NAME or None,
        "embed_loaded": _embed_model is not None,
    }


@app.post("/rerank")
def rerank(req: RerankRequest):
    """Score each text/document against the query. Returns the **jina** shape
    when called with `documents`, else the **tei** shape — so engram's `tei` and
    `jina` reranker formats both work against this one endpoint."""
    jina = req.documents is not None
    texts = req.documents if jina else (req.texts or [])
    if not texts:
        return {"results": []} if jina else []

    scores = [float(s) for s in model().predict([(req.query, t) for t in texts])]
    if jina:
        ranked = sorted(
            ({"index": i, "relevance_score": s} for i, s in enumerate(scores)),
            key=lambda r: r["relevance_score"],
            reverse=True,
        )
        if req.top_n:
            ranked = ranked[: req.top_n]
        return {"results": ranked}
    return [{"index": i, "score": s} for i, s in enumerate(scores)]


@app.post("/v1/embeddings")
@app.post("/embeddings")
def embeddings(req: EmbeddingRequest):
    """OpenAI-compatible embeddings over the SentenceTransformer embedder, so engram
    (EMBEDDING_API_BASE=http://reranker:80/v1) embeds on the GPU. The text is encoded
    verbatim — any instruction prefix (engram prepends QUERY_INSTRUCTION to queries
    only) is already applied upstream, so no prompt template is added here."""
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    vecs = embed_model().encode(
        texts,
        normalize_embeddings=EMBED_NORMALIZE,
        convert_to_numpy=True,
    )
    data = [
        {"object": "embedding", "index": i, "embedding": vec.tolist()}
        for i, vec in enumerate(vecs)
    ]
    return {
        "object": "list",
        "data": data,
        "model": req.model or EMBED_MODEL_NAME,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }
