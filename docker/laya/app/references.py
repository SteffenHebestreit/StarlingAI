"""Which checkpoint each model of the sidecar serves.

A fine-tuned checkpoint in LAYA_LOCAL_DIR/<model>/current wins over the configured one: the stock checkpoints are
not expected to make the swarm's decisions well until they have been fine-tuned on them (app/train.py writes
`current`, and only when it agrees with the incumbent more often than the checkpoint it replaces).
"""
from __future__ import annotations

import os

DEFAULTS = {
    "decision": ("LAYA_DECISION_MODEL", "convaiinnovations/laya#multilingual"),
    "browser": ("LAYA_BROWSER_MODEL", "cklxx/laya-browser#v14s"),
}


def local_dir() -> str:
    return os.environ.get("LAYA_LOCAL_DIR", "/models/local")


def current_dir(name: str) -> str:
    return os.path.join(local_dir(), name, "current")


def configured_reference(name: str) -> str:
    env, default = DEFAULTS[name]
    return os.environ.get(env, default)


def reference(name: str) -> str:
    """The checkpoint `name` ("decision" or "browser") is served from."""
    local = current_dir(name)
    if os.path.isfile(os.path.join(local, "rl_agent_config.json")):
        return local
    return configured_reference(name)
