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

  GET /health  -> 200 once every configured model has loaded and scored a probe input;
                  503 while that check runs, or with the error after it failed

Both models load lazily, on the first /health or the first request that needs them, so the
container starts fast and the healthcheck gates it. MODEL_NAME / EMBED_MODEL_NAME / USE_FP16 /
MAX_LENGTH are env-tunable.
"""

import math
import os
import threading

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

MODEL_NAME = os.environ.get("MODEL_NAME", "Qwen/Qwen3-Reranker-0.6B")
EMBED_MODEL_NAME = os.environ.get("EMBED_MODEL_NAME", "")
EMBED_NORMALIZE = os.environ.get("EMBED_NORMALIZE", "true").lower() == "true"
USE_FP16 = os.environ.get("USE_FP16", "true").lower() == "true"
MAX_LENGTH = int(os.environ.get("MAX_LENGTH", "512"))

app = FastAPI(title="engram qwen reranker + embedding sidecar")
_model = None
_embed_model = None
# Loads run one at a time. The gateway's first requests arrive as a burst, and each used
# to load its own copy of the model at the same moment. With sentence-transformers 6.1 and
# transformers 5.19 those parallel loads left lm_head on the meta device: every request in
# the burst failed with "Cannot copy out of meta tensor", and so did every later load in
# the process, while /health stayed green. One lock serves both models, so the embedder
# never loads beside the reranker either.
_load_lock = threading.Lock()


def model():
    """Load the CrossEncoder reranker once, on first use (keeps startup cheap)."""
    global _model
    if _model is None:
        with _load_lock:
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
        with _load_lock:
            if _embed_model is None:
                import torch
                from sentence_transformers import SentenceTransformer

                kwargs = {}
                if torch.cuda.is_available():
                    kwargs["device"] = "cuda"
                    if USE_FP16:
                        kwargs["model_kwargs"] = {"torch_dtype": torch.float16}
                _embed_model = SentenceTransformer(EMBED_MODEL_NAME, **kwargs)
    return _embed_model


# Readiness. /health used to answer 200 without touching a model, so a sidecar whose model
# could not load (the meta-tensor failure above) or could not run (no C compiler for
# triton) stayed healthy while every /rerank answered 500. The first /health now starts a
# check in the background that loads each configured model and scores one probe input, and
# /health answers 503 until that check has passed. A pass holds for the life of the process.
# A failed check keeps its error for /health to show and runs again on the next probe, so a
# transient failure (the first model download) can still recover.
_ready = False
_check_error = None
_check_thread = None
_check_lock = threading.Lock()


def _check_models():
    """Load every model this sidecar serves and run each once on a probe input. Raises
    when a model cannot load or answers with anything but finite numbers."""
    scores = [float(s) for s in model().predict([("readiness probe", "readiness probe")])]
    if len(scores) != 1 or not math.isfinite(scores[0]):
        raise RuntimeError(f"reranker scored one pair as {scores!r}")
    if EMBED_MODEL_NAME:
        vecs = embed_model().encode(["readiness probe"], convert_to_numpy=True)
        if len(vecs) != 1 or len(vecs[0]) == 0 or not all(math.isfinite(float(x)) for x in vecs[0]):
            raise RuntimeError("embedder returned no finite vector for one input")


def _run_check():
    global _ready, _check_error
    try:
        _check_models()
    except Exception as exc:  # any failure means not ready; /health shows it
        _check_error = f"{type(exc).__name__}: {exc}"
        return
    _check_error = None
    _ready = True


def _readiness():
    """(ready, last error). Starts the check when none has passed and none is running."""
    global _check_thread
    with _check_lock:
        if not _ready and (_check_thread is None or not _check_thread.is_alive()):
            _check_thread = threading.Thread(target=_run_check, name="readiness", daemon=True)
            _check_thread.start()
    return _ready, _check_error


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
def health():
    ready, error = _readiness()
    body = {
        "status": "ok" if ready else ("error" if error else "loading"),
        "model": MODEL_NAME,
        "loaded": _model is not None,
        "embed_model": EMBED_MODEL_NAME or None,
        "embed_loaded": _embed_model is not None,
    }
    if ready:
        return body
    if error:
        body["error"] = error
    return JSONResponse(status_code=503, content=body)


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
