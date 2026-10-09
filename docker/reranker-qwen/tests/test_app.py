"""The sidecar's load lock and its readiness check, with stand-ins for torch and
sentence-transformers: no model, no GPU and no torch install needed, only fastapi, httpx and
pytest. Run from the repo root: python -m pytest docker/reranker-qwen/tests

On 2026-10-08 a burst of first /rerank calls each loaded the model at the same moment, the
parallel loads left it unusable ("Cannot copy out of meta tensor"), and /health still answered
200 while every /rerank answered 500. These tests hold app.py to the two fixes: one load for any
number of callers, and a /health that stays 503 until every configured model has loaded and run.
"""
import importlib.util
import itertools
import sys
import threading
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

APP = Path(__file__).resolve().parent.parent / "app.py"
EMBEDDER = "Qwen/Qwen3-Embedding-0.6B"
_names = itertools.count()


class Models:
    """The stand-in sentence_transformers. It counts the models built and how many were being
    built at once, and lets a test hold a build open, make it fail, or change what a model returns."""

    def __init__(self):
        self.lock = threading.Lock()
        self.built = {"CrossEncoder": 0, "SentenceTransformer": 0}
        self.building = 0
        self.most_at_once = 0
        self.open = {"CrossEncoder": threading.Event(), "SentenceTransformer": threading.Event()}
        for event in self.open.values():
            event.set()
        self.fail = None
        self.score = 1.5
        self.vector = [0.1, 0.2]

    def build(self, kind):
        with self.lock:
            self.built[kind] += 1
            self.building += 1
            self.most_at_once = max(self.most_at_once, self.building)
        try:
            # Long enough that builds nothing serializes overlap.
            time.sleep(0.2)
            if not self.open[kind].wait(10):
                raise TimeoutError(f"{kind} was held open and never released")
            if self.fail is not None:
                raise self.fail
        finally:
            with self.lock:
                self.building -= 1


@pytest.fixture
def models(monkeypatch):
    models = Models()

    class CrossEncoder:
        def __init__(self, name, **kwargs):
            models.build("CrossEncoder")

        def predict(self, pairs):
            return [models.score for _ in pairs]

    class SentenceTransformer:
        def __init__(self, name, **kwargs):
            models.build("SentenceTransformer")

        def encode(self, texts, **kwargs):
            return [list(models.vector) for _ in texts]

    torch = types.ModuleType("torch")
    torch.float16 = "float16"
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    sentence_transformers = types.ModuleType("sentence_transformers")
    sentence_transformers.CrossEncoder = CrossEncoder
    sentence_transformers.SentenceTransformer = SentenceTransformer
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "sentence_transformers", sentence_transformers)
    return models


@pytest.fixture
def load_app(monkeypatch):
    """A fresh copy of app.py, so no test sees another's loaded model or readiness."""

    def load(embed_model=None):
        if embed_model:
            monkeypatch.setenv("EMBED_MODEL_NAME", embed_model)
        else:
            monkeypatch.delenv("EMBED_MODEL_NAME", raising=False)
        name = f"reranker_app_{next(_names)}"
        spec = importlib.util.spec_from_file_location(name, APP)
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
        return module

    return load


def at_once(*calls):
    """Runs every call on its own thread, all released together; returns what each raised."""
    barrier = threading.Barrier(len(calls))
    errors = []

    def run(call):
        barrier.wait()
        try:
            call()
        except Exception as exc:  # collected for the assertion, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(call,)) for call in calls]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)
    return errors


def settle(client, seconds=10):
    """GET /health until the check it starts is no longer running, and return that answer."""
    deadline = time.monotonic() + seconds
    while True:
        answer = client.get("/health")
        if answer.json()["status"] != "loading" or time.monotonic() > deadline:
            return answer
        time.sleep(0.02)


def test_a_burst_of_first_calls_builds_the_reranker_once(models, load_app):
    app = load_app()
    assert at_once(*[app.model] * 5) == []
    assert models.built["CrossEncoder"] == 1
    assert models.most_at_once == 1


def test_the_embedder_never_loads_beside_the_reranker(models, load_app):
    app = load_app(EMBEDDER)
    assert at_once(app.model, app.embed_model, app.model, app.embed_model) == []
    assert models.built == {"CrossEncoder": 1, "SentenceTransformer": 1}
    assert models.most_at_once == 1


def test_health_answers_503_while_the_model_loads_then_200(models, load_app):
    app = load_app()
    client = TestClient(app.app)
    models.open["CrossEncoder"].clear()
    loading = client.get("/health")
    assert loading.status_code == 503
    assert loading.json()["status"] == "loading"
    assert loading.json()["loaded"] is False

    models.open["CrossEncoder"].set()
    ready = settle(client)
    assert ready.status_code == 200
    assert ready.json()["status"] == "ok"
    assert ready.json()["loaded"] is True
    assert models.built["CrossEncoder"] == 1
    assert client.post("/rerank", json={"query": "q", "texts": ["a", "b"]}).json() == [
        {"index": 0, "score": 1.5},
        {"index": 1, "score": 1.5},
    ]


def test_a_model_that_cannot_load_keeps_health_at_503_with_the_error(models, load_app):
    client = TestClient(load_app().app)
    models.fail = OSError("no such model")
    failed = settle(client)
    assert failed.status_code == 503
    assert failed.json()["status"] == "error"
    assert failed.json()["error"] == "OSError: no such model"
    # Each later probe checks again and reports the same, never 200.
    for _ in range(5):
        again = settle(client)
        assert again.status_code == 503
        assert again.json()["error"] == "OSError: no such model"

    # A failure that passes (the first download) recovers on a later probe.
    models.fail = None
    recovered = settle(client)
    deadline = time.monotonic() + 10
    while recovered.status_code != 200 and time.monotonic() < deadline:
        recovered = settle(client)
    assert recovered.status_code == 200


def test_a_model_that_scores_nothing_usable_keeps_health_at_503(models, load_app):
    client = TestClient(load_app().app)
    models.score = float("nan")
    failed = settle(client)
    assert failed.status_code == 503
    assert failed.json()["status"] == "error"
    assert failed.json()["error"] == "RuntimeError: reranker scored one pair as [nan]"
    assert failed.json()["loaded"] is True


def test_with_an_embedder_health_waits_for_it_too(models, load_app):
    client = TestClient(load_app(EMBEDDER).app)
    models.open["SentenceTransformer"].clear()
    deadline = time.monotonic() + 10
    waiting = client.get("/health")
    while not waiting.json()["loaded"] and time.monotonic() < deadline:
        time.sleep(0.02)
        waiting = client.get("/health")
    # The reranker has loaded and run; the embedder has not.
    assert waiting.status_code == 503
    assert waiting.json()["status"] == "loading"
    assert waiting.json()["loaded"] is True
    assert waiting.json()["embed_loaded"] is False

    models.open["SentenceTransformer"].set()
    ready = settle(client)
    assert ready.status_code == 200
    assert ready.json()["embed_loaded"] is True


def test_an_embedder_that_returns_no_finite_vector_keeps_health_at_503(models, load_app):
    client = TestClient(load_app(EMBEDDER).app)
    models.vector = [float("nan"), 0.2]
    failed = settle(client)
    assert failed.status_code == 503
    assert failed.json()["error"] == "RuntimeError: embedder returned no finite vector for one input"
