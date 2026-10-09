"""Which checkpoint the sidecar serves, how it names it, and how a fine-tune replaces it — with a stand-in for laya."""
import json
import os
import sys
import types

from app import references, train
from app.models import Model, parse_reference


def fake_laya(monkeypatch, cfg):
    class Agent:
        device = types.SimpleNamespace(type="cpu")

        def __init__(self):
            self.cfg = dict(cfg)

    module = types.ModuleType("laya")
    module.load = lambda repo, subfolder=None, device=None: Agent()
    monkeypatch.setitem(sys.modules, "laya", module)


def test_a_fine_tune_is_named_by_its_run_so_the_gateway_keeps_its_statistics_apart(monkeypatch):
    fake_laya(monkeypatch, {"starlingai_run": "20260926-010203"})
    model = Model("decision", "/models/local/decision/current")
    assert model.version == "/models/local/decision/current"
    model.load()
    assert model.version == "/models/local/decision/current@20260926-010203"
    assert model.status()["version"] == model.version


def test_a_stock_checkpoint_is_named_by_its_reference(monkeypatch):
    fake_laya(monkeypatch, {})
    model = Model("browser", "cklxx/laya-browser#v15s")
    model.load()
    assert model.version == "cklxx/laya-browser#v15s"


def test_a_reference_names_repo_revision_and_subfolder():
    assert parse_reference("cklxx/laya-browser@7139587#v15s") == ("cklxx/laya-browser", "7139587", "v15s")
    assert parse_reference("cklxx/laya-browser#v15s") == ("cklxx/laya-browser", None, "v15s")
    assert parse_reference("org/model@main") == ("org/model", "main", None)


def test_a_pinned_reference_loads_that_commit_s_snapshot_not_main(monkeypatch, tmp_path):
    loaded, fetched = [], []

    class Agent:
        device = types.SimpleNamespace(type="cpu")
        cfg = {}

    laya = types.ModuleType("laya")
    laya.load = lambda path, subfolder=None, device=None: loaded.append((path, subfolder)) or Agent()
    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = lambda **kwargs: fetched.append(kwargs) or str(tmp_path)
    monkeypatch.setitem(sys.modules, "laya", laya)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    model = Model("browser", "cklxx/laya-browser@7139587#v15s")
    model.load()
    assert fetched == [{"repo_id": "cklxx/laya-browser", "revision": "7139587", "allow_patterns": ["v15s/*"]}]
    assert loaded == [(os.path.join(str(tmp_path), "v15s"), None)], "loaded from the snapshot on disk, not from the hub's main"
    assert model.version == "cklxx/laya-browser@7139587#v15s"


def test_the_default_checkpoints_are_pinned_to_a_commit(monkeypatch):
    for name, (env, _) in references.DEFAULTS.items():
        monkeypatch.delenv(env, raising=False)
        _, revision, _ = parse_reference(references.configured_reference(name))
        assert revision is not None and len(revision) == 40, f"{name} follows the hub's main branch"


def test_a_local_current_checkpoint_wins_over_the_configured_one(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYA_LOCAL_DIR", str(tmp_path))
    monkeypatch.delenv("LAYA_BROWSER_MODEL", raising=False)
    configured = references.configured_reference("browser")
    assert references.reference("browser") == configured
    current = tmp_path / "browser" / "current"
    current.mkdir(parents=True)
    assert references.reference("browser") == configured, "an empty directory is not a checkpoint"
    (current / "rl_agent_config.json").write_text("{}")
    assert references.reference("browser") == str(current)


def test_a_promoted_run_replaces_current_whole(monkeypatch, tmp_path):
    monkeypatch.setenv("LAYA_LOCAL_DIR", str(tmp_path))
    old = tmp_path / "decision" / "current"
    old.mkdir(parents=True)
    (old / "rl_agent_config.json").write_text(json.dumps({"starlingai_run": "old"}))
    (old / "stale.bin").write_text("x")
    run = tmp_path / "decision" / "runs" / "new"
    run.mkdir(parents=True)
    (run / "rl_agent_config.json").write_text(json.dumps({"starlingai_run": "new"}))
    assert train.promote(str(run), "decision") == str(old)
    assert json.loads((old / "rl_agent_config.json").read_text())["starlingai_run"] == "new"
    assert not (old / "stale.bin").exists(), "nothing of the replaced checkpoint is left behind"
    assert (run / "rl_agent_config.json").exists(), "the run itself stays, for the record"
    assert sorted(p.name for p in (tmp_path / "decision").iterdir()) == ["current", "runs"]
