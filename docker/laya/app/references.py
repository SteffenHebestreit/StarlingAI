"""Which checkpoint each model of the sidecar serves.

A fine-tuned checkpoint in LAYA_LOCAL_DIR/<model>/current wins over the configured one: the stock checkpoints are
not expected to make the swarm's decisions well until they have been fine-tuned on them (app/train.py writes
`current`, and only when it agrees with the incumbent more often than the checkpoint it replaces).
"""
from __future__ import annotations

import os

# Pinned to a commit (models.load_reference): a hub repo's main branch moves, and cklxx/laya-browser removed the
# subfolder we served from main on 2026-09-26. v15s is the same format (laya_fmt v3, head_max_len 768) and the same
# serving code as v14s, retrained without the DAgger set that leaked suite-A goals into v10-v14s. A new reference is a
# new model version, so the gateway's gate starts its evidence again.
DEFAULTS = {
    "decision": ("LAYA_DECISION_MODEL", "convaiinnovations/laya@55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851#multilingual"),
    "browser": ("LAYA_BROWSER_MODEL", "cklxx/laya-browser@7139587325a39cd8639900bff21c3a2145969fd8#v15s"),
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
