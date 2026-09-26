"""The Laya checkpoints this sidecar serves: loaded once, used one inference at a time, watched for a silent CPU fallback.

A model is named by a reference: a local directory (a fine-tuned checkpoint), or `<hf repo>[@<revision>][#<subfolder>]`
such as `convaiinnovations/laya@55cf4c4…#multilingual` — only that subfolder is downloaded into HF_HOME. Without a
revision laya.load reads the repo's main branch, which is not stable: see load_reference.

laya 0.3.20 moves a model to the CPU for the life of the process after any CUDA error whose message mentions "cuda"
or "memory" (agent.py `_infer`), so a GPU sidecar can quietly become ~10x slower. After every call the device is
compared with the one the model was loaded on; a fallback drops the model so the next call loads it on the GPU again,
and /health reports how often that happened.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Callable, Dict, Optional

log = logging.getLogger("laya.sidecar")


def parse_reference(reference: str) -> tuple[str, Optional[str], Optional[str]]:
    """(repo or directory, revision, subfolder) of a reference."""
    if os.path.isdir(reference):
        return reference, None, None
    head, _, subfolder = reference.partition("#")
    repo, _, revision = head.partition("@")
    return repo, (revision or None), (subfolder or None)


def load_reference(reference: str, device: Optional[str]) -> Any:
    """laya's agent for `reference`, on `device`.

    laya.load (0.3.20) reads a hub repo at its main branch only, and main moves: on 2026-09-26 cklxx/laya-browser
    replaced its checkpoints with v15s and removed the v14s subfolder from main (commit 7139587), so the reference
    `cklxx/laya-browser#v14s` stopped loading on the next start. A reference with a revision is fetched as that
    commit's snapshot and loaded from disk, so what a deployment serves changes only when its reference does.
    """
    import laya  # imported here so a test can run the request logic without torch

    repo, revision, subfolder = parse_reference(reference)
    if revision is None:
        return laya.load(repo, subfolder=subfolder, device=device)
    from huggingface_hub import snapshot_download

    root = snapshot_download(repo_id=repo, revision=revision, allow_patterns=[f"{subfolder}/*"] if subfolder else None)
    return laya.load(os.path.join(root, subfolder) if subfolder else root, device=device)


class Model:
    def __init__(self, name: str, reference: str, device: Optional[str] = None, configure: Optional[Callable[[Any], None]] = None):
        self.name = name
        self.reference = reference
        self.wanted_device = device
        self.configure = configure
        self.agent: Any = None
        self.loaded_device: Optional[str] = None
        self.error: Optional[str] = None
        self.load_seconds: Optional[float] = None
        self.calls = 0
        self.cpu_fallbacks = 0
        self.loading = False
        self._lock = threading.RLock()
        self._version: Optional[str] = None

    def load(self) -> Any:
        with self._lock:
            if self.agent is not None:
                return self.agent
            self.loading = True
            started = time.perf_counter()
            try:
                agent = load_reference(self.reference, self.wanted_device)
                if self.configure:
                    self.configure(agent)
            except Exception as err:  # reported by /health; the request that triggered the load fails
                self.error = f"{type(err).__name__}: {err}"
                raise
            finally:
                self.loading = False
            self.agent = agent
            self.loaded_device = str(agent.device.type)
            self.load_seconds = round(time.perf_counter() - started, 1)
            self.error = None
            run = agent.cfg.get("starlingai_run") if isinstance(getattr(agent, "cfg", None), dict) else None
            self._version = f"{self.reference}@{run}" if run else self.reference
            log.info("loaded %s (%s) on %s in %.1fs", self.name, self.version, self.loaded_device, self.load_seconds)
            return agent

    @property
    def version(self) -> str:
        """What gave an answer: the checkpoint reference, with the run id of a fine-tune (app/train.py)."""
        return self._version or self.reference

    def run(self, fn: Callable[[Any], Any]) -> Any:
        """`fn(agent)` with the model held for this call alone: one inference at a time per model."""
        with self._lock:
            agent = self.load()
            result = fn(agent)
            self.calls += 1
            if self.loaded_device == "cuda" and agent.device.type != "cuda":
                self.cpu_fallbacks += 1
                log.warning("%s fell back to the CPU after a CUDA error; it is reloaded on the GPU for the next call", self.name)
                self.agent = None
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001 - best effort
                    pass
            return result

    def status(self) -> Dict[str, Any]:
        return {
            "reference": self.reference,
            "version": self.version,
            "loaded": self.agent is not None,
            "loading": self.loading,
            "device": str(self.agent.device.type) if self.agent is not None else None,
            "loadSeconds": self.load_seconds,
            "calls": self.calls,
            "cpuFallbacks": self.cpu_fallbacks,
            **({"error": self.error} if self.error else {}),
        }
