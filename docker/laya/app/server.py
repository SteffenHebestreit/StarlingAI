"""The Laya sidecar: fast local choice decisions for StarlingAI.

    GET  /health               models, devices, calls, CPU fallbacks
    POST /v1/decide            {"questions": [{"id", "question", "options": {key: description}, "state"}]}
                               -> {"answers": {id: {"choice": key, "probabilities": {key: p}}}, "ms", "tokens"}
    POST /v1/browser/step      {"goal", "observation": <jev snapshot>, "history": [...], "excluded": [...]}
                               -> {"operation", "operationProbability", "target" | "control", ...}

Configuration (environment):
    LAYA_DECISION_MODEL   checkpoint for /v1/decide     (default convaiinnovations/laya#multilingual)
    LAYA_BROWSER_MODEL    checkpoint for browser steps  (default cklxx/laya-browser#v14s)
    LAYA_LOCAL_DIR        fine-tuned checkpoints (default /models/local); <dir>/<model>/current wins over the above
    LAYA_DEVICE           cuda | cpu | unset for automatic
    LAYA_PRELOAD          comma list of models to load at start (default decision,browser; empty = on first use)
    LAYA_BROWSER_CHUNK    widest choice decided in one pass (default 60, as laya-browser v14s recommends)

Every answer names the model version that gave it ("model"): a fine-tune's run id, else the checkpoint reference.
The gateway keeps its agreement statistics per version, so a new checkpoint earns its handover again.

It has no authentication: like the reranker it is reachable only on the compose networks.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from . import browser, generic, references
from .models import Model

logging.basicConfig(level=os.environ.get("LAYA_LOG_LEVEL", "INFO"))
log = logging.getLogger("laya.sidecar")

MAX_BODY_BYTES = 2 * 1024 * 1024
DEVICE = os.environ.get("LAYA_DEVICE") or None
BROWSER_CHUNK = int(os.environ.get("LAYA_BROWSER_CHUNK", "60"))

MODELS: Dict[str, Model] = {
    "decision": Model("decision", references.reference("decision"), DEVICE),
    "browser": Model("browser", references.reference("browser"), DEVICE, browser.configure_agent),
}

app = FastAPI(title="laya sidecar", docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
def _preload() -> None:
    names = [n.strip() for n in os.environ.get("LAYA_PRELOAD", "decision,browser").split(",") if n.strip()]

    def load_all() -> None:
        for name in names:
            model = MODELS.get(name)
            if model is None:
                log.warning("LAYA_PRELOAD names an unknown model: %s", name)
                continue
            try:
                model.load()
            except Exception:  # noqa: BLE001 - reported by /health
                log.exception("could not load %s", name)

    threading.Thread(target=load_all, name="laya-preload", daemon=True).start()


@app.middleware("http")
async def _limit_body(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": f"body larger than {MAX_BODY_BYTES} bytes"}, status_code=413)
    return await call_next(request)


@app.get("/health")
def health() -> Dict[str, Any]:
    try:
        import torch
        cuda = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        cuda = False
    statuses = {name: model.status() for name, model in MODELS.items()}
    degraded = any(s.get("error") or s["cpuFallbacks"] for s in statuses.values())
    loading = any(s["loading"] for s in statuses.values())
    return {"status": "degraded" if degraded else "loading" if loading else "ok", "cuda": cuda, "models": statuses}


def _answer(fn):
    started = time.perf_counter()
    try:
        result = fn()
    except (generic.BadRequest, browser.BadRequest) as err:
        return JSONResponse({"error": str(err)}, status_code=422)
    except Exception as err:  # noqa: BLE001 - never leak a stack to the caller
        log.exception("request failed")
        return JSONResponse({"error": type(err).__name__}, status_code=500)
    return {**result, "ms": round((time.perf_counter() - started) * 1000, 1)}


@app.post("/v1/decide")
def decide(body: Any = Body(...)):
    def run() -> Dict[str, Any]:
        questions = generic.validate(body)
        model = MODELS["decision"]
        result = generic.decide_all(lambda state, qs: model.run(lambda agent: agent.system_one(state, qs)), questions)
        return {**result, "model": model.version}
    return _answer(run)


@app.post("/v1/browser/step")
def browser_step(body: Any = Body(...)):
    def run() -> Dict[str, Any]:
        if not isinstance(body, dict) or not isinstance(body.get("observation"), dict):
            raise browser.BadRequest("body must carry the page observation")
        model = MODELS["browser"]
        step = browser.decide_step(
            lambda state, qs: model.run(lambda agent: agent.system_one(state, qs)),
            body["observation"],
            body.get("goal", ""),
            body.get("history") or [],
            body.get("excluded") or None,
            BROWSER_CHUNK,
        )
        return {**step, "model": model.version}
    return _answer(run)
