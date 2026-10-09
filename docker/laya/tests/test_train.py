"""Fine-tuning data: cases built from the gateway's exports exactly as the sidecar serves the questions, the held-out
split, the balancing and the promotion rule — everything short of the model itself, so no torch is needed."""
import json
import math

import pytest

from app import browser, generic, train

OBSERVATION = {
    "url": "https://shop.example/",
    "title": "Shop",
    "text": "Welcome to the shop",
    "actions": [
        {"id": "e1", "kind": "click", "node": 1, "role": "link", "label": "Home", "value": ""},
        {"id": "e2", "kind": "click", "node": 2, "role": "link", "label": "Products", "value": ""},
        {"id": "e3", "kind": "fill", "node": 3, "role": "textbox", "label": "Query", "value": ""},
        {"id": "e4", "kind": "click", "node": 3, "role": "textbox", "label": "Open Query", "value": ""},
        {"id": "e5", "kind": "select", "node": 4, "role": "combobox", "label": "Sort → Newest", "value": "new", "current_value": "Price"},
        {"id": "e6", "kind": "select", "node": 4, "role": "combobox", "label": "Sort → Cheapest", "value": "cheap", "current_value": "Price"},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ],
}


def browser_row(**model):
    return {
        "point": "browser_step", "language": "en", "sessionId": "run-1", "ts": "2026-09-26T10:00:00Z", "decidedBy": "model",
        "goal": "Open the products page", "observation": OBSERVATION, "history": [{"action": "Home", "kind": "click", "text": None, "page_changed": True}],
        "model": model,
    }


def export_row(point="source_sensitive", label="A", state=None):
    """A row as scripts/decisions-export.ts writes it."""
    criteria = {"A": "It depends on specific facts that must be verified.", "B": "General knowledge or reasoning."}
    return {
        "point": point, "language": "de",
        "state": json.dumps(state if state is not None else {"message": "Wie funktioniert das Pfandsystem in Dänemark?"}, separators=(",", ":")),
        "questions": {point: {"type": "choice", "instructions": "Does answering this require checkable real-world facts?", "criteria": criteria}},
        "gold": {point: {"label": label, "probabilities": {"A": 1 if label == "A" else 0, "B": 1 if label == "B" else 0}}},
    }


def test_a_decision_case_is_the_question_the_sidecar_serves_for_the_same_request():
    (case,), skipped = train.decision_cases([export_row()])
    assert skipped == 0
    request = {
        "id": "source_sensitive",
        "question": "Does answering this require checkable real-world facts?",
        "options": {"yes": "It depends on specific facts that must be verified.", "no": "General knowledge or reasoning."},
        "state": {"message": "Wie funktioniert das Pfandsystem in Dänemark?"},
    }
    _keys, served = generic.to_laya(request)
    assert case.question == served
    # The state is the object the gateway sent, not its JSON text: the model serialises it the same way either path.
    assert case.state == request["state"]
    assert case.gold == "A" and case.label() == 0


def test_unusable_decision_rows_are_counted_not_trained_on():
    broken = [{"point": "x"}, {**export_row(), "gold": {"source_sensitive": {"label": "Z"}}}, {**export_row(), "state": "{not json"}]
    cases, skipped = train.decision_cases(broken)
    assert cases == [] and skipped == 3


def test_a_browser_case_is_what_laya_browser_is_asked_and_the_models_choice():
    cases, skipped = train.browser_cases([browser_row(tool="browser_click", operation="CLICK", node=2)], chunk=60)
    assert skipped == 0
    assert [(c.point, c.gold) for c in cases] == [("browser:operation", "CLICK"), ("browser:click_target", "2")]

    # Exactly what predict_jev_body hands the model for the same page, goal and history.
    sent = []

    def predict(state, questions):
        sent.append((state, questions))
        return {"answers": {qid: {"choice": next(iter(q["criteria"])), "probabilities": {k: 1 / len(q["criteria"]) for k in q["criteria"]}}
                            for qid, q in questions.items()}}

    browser.decide_step(predict, OBSERVATION, "Open the products page", [{"action": "Home", "kind": "click", "text": None, "page_changed": True}])
    state, questions = sent[0]
    assert cases[0].state == state
    assert cases[0].question == questions["operation"]
    assert cases[1].question == questions["click_target"]


def test_a_select_names_its_option_by_the_value_the_model_chose():
    cases, _ = train.browser_cases([browser_row(tool="browser_select_option", operation="SELECT", node=4, values=["cheap"])], chunk=60)
    # The fourth element (Sort), its second option (Cheapest).
    assert [(c.point, c.gold) for c in cases] == [("browser:operation", "SELECT"), ("browser:select_target", "4:2")]


def test_an_element_that_was_not_found_teaches_the_operation_only():
    cases, _ = train.browser_cases([browser_row(tool="browser_click", operation="CLICK", node=None)], chunk=60)
    assert [c.point for c in cases] == ["browser:operation"]


def test_steps_laya_browser_took_and_operations_it_did_not_offer_are_not_training_data():
    taken = {**browser_row(tool="browser_click", operation="CLICK", node=2), "decidedBy": "laya"}
    impossible = browser_row(tool="browser_select_option", operation="SELECT_SOMETHING", node=4)
    cases, skipped = train.browser_cases([taken, impossible], chunk=60)
    assert cases == [] and skipped == 2


def test_a_wide_target_list_is_cut_to_the_chunk_width_around_the_models_element():
    wide = {**OBSERVATION, "actions": [{"id": f"e{i}", "kind": "click", "node": i, "role": "link", "label": f"Link {i}", "value": ""} for i in range(1, 91)]}
    row = {**browser_row(tool="browser_click", operation="CLICK", node=77), "observation": wide}
    cases, _ = train.browser_cases([row], chunk=60)
    target = cases[1]
    assert len(target.question["criteria"]) == 60
    assert target.gold == "77" and "77" in target.question["criteria"]
    keys = list(target.question["criteria"])
    assert keys == sorted(keys, key=int), "the page order is kept"
    again, _ = train.browser_cases([row], chunk=60)
    assert list(again[1].question["criteria"]) == keys, "the same row is cut the same way every run"


def test_whole_groups_are_held_out():
    cases = [train.Case("p", f"run-{i // 3}", {}, {"criteria": {"A": "a", "B": "b"}}, "A") for i in range(300)]
    train_cases, held = train.split(cases)
    assert 30 <= len(held) <= 90
    held_groups = {c.group for c in held}
    assert not held_groups & {c.group for c in train_cases}


def test_rarer_answers_are_repeated_towards_a_third_of_the_most_common():
    cases = [train.Case("p", str(i), {}, {"criteria": {"A": "a", "B": "b"}}, "A") for i in range(90)]
    cases += [train.Case("p", f"b{i}", {}, {"criteria": {"A": "a", "B": "b"}}, "B") for i in range(10)]
    out = train.balanced(cases)
    assert sum(c.gold == "A" for c in out) == 90
    assert sum(c.gold == "B" for c in out) == 30


def test_a_checkpoint_replaces_the_served_one_only_when_it_agrees_more_and_no_point_got_worse():
    base = {"n": 100, "accuracy": 0.80, "points": {"a": {"n": 50, "accuracy": 0.9}, "b": {"n": 50, "accuracy": 0.7}}}
    better = {"n": 100, "accuracy": 0.86, "points": {"a": {"n": 50, "accuracy": 0.89}, "b": {"n": 50, "accuracy": 0.83}}}
    assert train.promotion(base, better)[0] is True
    same = {**better, "accuracy": 0.80}
    assert train.promotion(base, same)[0] is False
    worse_point = {"n": 100, "accuracy": 0.86, "points": {"a": {"n": 50, "accuracy": 0.80}, "b": {"n": 50, "accuracy": 0.92}}}
    ok, why = train.promotion(base, worse_point)
    assert ok is False and "a got worse" in why
    few = {"n": 100, "accuracy": 0.86, "points": {"a": {"n": 5, "accuracy": 0.2}, "b": {"n": 95, "accuracy": 0.9}}}
    assert train.promotion(base, few)[0] is True, "a point with too few held-out cases does not veto"


def test_the_temperature_fit_and_agreement_need_no_model():
    items = [{"label": 0, "point": "p", "markers": [1, 2]}, {"label": 1, "point": "p", "markers": [1, 2]}]
    logits = [[2.0, 0.0], [0.5, 0.0]]
    metrics = train.evaluate(logits, items)
    assert metrics["accuracy"] == 0.5 and metrics["points"] == {"p": {"n": 2, "accuracy": 0.5}}
    assert train.evaluate(logits, items, train.fit_temperature(logits, items))["nll"] <= metrics["nll"]


def test_the_temperature_is_fitted_within_the_range_laya_applies():
    # Perfectly separated cases would want an ever sharper temperature; laya would clamp anything below 0.5.
    items = [{"label": 0, "point": "p", "markers": [1, 2]}] * 3
    assert abs(train.fit_temperature([[8.0, 0.0]] * 3, items) - 0.5) < 1e-9
    # And cases that are all wrong want it as soft as laya allows.
    assert abs(train.fit_temperature([[0.0, 8.0]] * 3, items) - 5.0) < 1e-9


def synthetic_logits(t_true, n=4_000, seed=7):
    """Two-option cases whose labels are drawn from softmax(z / t_true): the temperature that generated them is the one
    a fit must find."""
    import random
    rng = random.Random(seed)
    logits, items = [], []
    for _ in range(n):
        gap = rng.uniform(-12.0, 12.0)
        p_first = 1.0 / (1.0 + math.exp(-gap / t_true))
        logits.append([gap, 0.0])
        items.append({"label": 0 if rng.random() < p_first else 1, "point": "p", "markers": [1, 2]})
    return logits, items


def test_the_fit_recovers_a_temperature_inside_laya_s_range():
    logits, items = synthetic_logits(2.0)
    fit = train.temperature_fit(logits, items)
    assert abs(fit["fitted"] - 2.0) / 2.0 < 0.05
    assert fit["atBound"] is None and fit["fold"] == 1.0 and fit["served"] == fit["fitted"] == fit["effective"]
    assert train.fit_temperature(logits, items) == fit["served"]


def test_a_fit_softer_than_laya_s_cap_is_recovered_reported_and_folded():
    # Run 20260926-073740: the held-out loss kept falling past 5.00, the old grid's edge, to about 8.
    logits, items = synthetic_logits(8.0)
    fit = train.temperature_fit(logits, items)
    assert abs(fit["fitted"] - 8.0) / 8.0 < 0.05, fit
    assert fit["atBound"] == "upper"
    assert fit["served"] == train.TEMPERATURE_RANGE[1]
    assert abs(fit["fold"] * fit["served"] - fit["fitted"]) < 1e-9
    assert fit["nll"]["atEffective"] < fit["nll"]["atServedWithoutFold"], "what is served must be the better fit"


def test_a_fit_sharper_than_laya_s_floor_is_reported_and_served_at_the_floor():
    logits, items = synthetic_logits(0.25)
    fit = train.temperature_fit(logits, items)
    assert abs(fit["fitted"] - 0.25) / 0.25 < 0.05, fit
    assert fit["atBound"] == "lower"
    assert fit["served"] == fit["effective"] == train.TEMPERATURE_RANGE[0], "never sharper than laya allows"
    assert fit["fold"] == 1.0


def test_folding_divides_every_choice_logit_exactly():
    torch = pytest.importorskip("torch")
    torch.manual_seed(0)
    model = torch.nn.Module()
    model.scorer = torch.nn.Sequential(torch.nn.LayerNorm(8), torch.nn.Linear(8, 8), torch.nn.GELU(), torch.nn.Linear(8, 1))
    x = torch.randn(5, 3, 8)
    before = model.scorer(x).detach()
    train.fold_temperature(model, 1.6)
    after = model.scorer(x).detach()
    assert torch.allclose(after, before / 1.6, atol=1e-6)


def test_the_run_saves_the_checkpoint_its_metrics_describe(monkeypatch, tmp_path):
    """main() with the model stubbed out: held-out cases that ask for a temperature of 8 are saved at laya's cap of 5
    with the rest folded into the head BEFORE the checkpoint is written — else metrics.json would describe a softer
    checkpoint than the one served."""
    import types

    held_logits, held_items = synthetic_logits(8.0)
    cases = [types.SimpleNamespace(point="p", gold="A") for _ in range(10)]
    agent = types.SimpleNamespace(model=object())
    folded, saved = [], {}
    data = tmp_path / "export.jsonl"
    data.write_text("", encoding="utf-8")
    monkeypatch.setattr(train.references, "reference", lambda name: "base-checkpoint")
    monkeypatch.setattr(train.references, "local_dir", lambda: str(tmp_path))
    monkeypatch.setattr(train, "read_jsonl", lambda path: [])
    monkeypatch.setattr(train, "decision_cases", lambda rows: (cases, 0))
    monkeypatch.setattr(train, "split", lambda all_cases: (all_cases[:5], all_cases[5:]))
    monkeypatch.setattr(train, "load_agent", lambda reference, device, name: agent)
    monkeypatch.setattr(train, "balanced", lambda some: some)
    monkeypatch.setattr(train, "order_augmented", lambda some: some)
    monkeypatch.setattr(train, "order_flips", lambda a, some: {"flips": 0, "pairs": len(some)})
    monkeypatch.setattr(train, "encode", lambda a, some: held_items)
    monkeypatch.setattr(train, "logits_of", lambda a, items: held_logits)
    monkeypatch.setattr(train, "train", lambda a, items, epochs: None)
    monkeypatch.setattr(train, "fold_temperature", lambda model, factor: folded.append((model, factor)))
    monkeypatch.setattr(train, "save", lambda a, out, run, temperature, metrics: saved.update(
        temperature=temperature, metrics=metrics, folded_before=len(folded)))

    assert train.main(["decision", "--data", str(data), "--min-cases", "0", "--no-promote"]) == 0
    fit = saved["metrics"]["temperatureFit"]
    assert fit["atBound"] == "upper" and abs(fit["effective"] - 8.0) / 8.0 < 0.05, fit
    assert saved["temperature"] == saved["metrics"]["temperature"] == train.TEMPERATURE_RANGE[1], "laya is given what it applies"
    assert folded == [(agent.model, fit["fold"])], "the rest of the fitted temperature was not folded into the head"
    assert saved["folded_before"] == 1, "the checkpoint was written before the fold"


def test_a_reordered_case_carries_its_answer_with_its_option():
    two = train.Case("fast_lane", "g", {"message": "hi"}, {"type": "choice", "instructions": "i", "criteria": {"A": "small talk", "B": "a task"}}, "A")
    flipped = train.reordered(two)
    assert flipped.question["criteria"] == {"A": "a task", "B": "small talk"}
    assert flipped.gold == "B" and flipped.question["criteria"][flipped.gold] == "small talk"
    assert flipped.group == two.group, "a case and its twin are held out together"
    three = train.Case("p", "g", {}, {"type": "choice", "instructions": "i", "criteria": {"A": "x", "B": "y", "C": "z"}}, "B")
    assert train.reordered(three).gold == "B" and train.reordered(three).question["criteria"]["B"] == "y"
    assert train.reordered(train.Case("p", "g", {}, three.question, "A")).question["criteria"][train.reordered(train.Case("p", "g", {}, three.question, "A")).gold] == "x"


def test_decision_training_sees_every_case_in_both_orders(monkeypatch, tmp_path):
    import types

    rows = [{"point": "fast_lane", "state": json.dumps({"message": f"m{i}"}), "questions": {"fast_lane": {
        "type": "choice", "instructions": "i", "criteria": {"A": "small talk", "B": "a task"}}},
        "gold": {"fast_lane": {"label": "A" if i % 3 else "B"}}} for i in range(12)]
    seen = {}
    monkeypatch.setattr(train.references, "reference", lambda name: "base")
    monkeypatch.setattr(train.references, "local_dir", lambda: str(tmp_path))
    monkeypatch.setattr(train, "read_jsonl", lambda path: rows)
    monkeypatch.setattr(train, "load_agent", lambda reference, device, name: types.SimpleNamespace(model=object()))
    monkeypatch.setattr(train, "encode", lambda a, some: [{"point": c.point, "label": c.label(), "text": c.question["criteria"][c.gold]} for c in some])
    monkeypatch.setattr(train, "logits_of", lambda a, items: [[0.0, 1.0] for _ in items])
    monkeypatch.setattr(train, "train", lambda a, items, epochs: seen.update(items=items))
    monkeypatch.setattr(train, "fold_temperature", lambda model, factor: None)
    monkeypatch.setattr(train, "save", lambda *a, **k: None)
    data = tmp_path / "export.jsonl"
    data.write_text("", encoding="utf-8")
    assert train.main(["decision", "--data", str(data), "--min-cases", "0", "--no-promote"]) == 0
    items = seen["items"]
    assert len(items) % 2 == 0
    for served, twin in zip(items[0::2], items[1::2]):
        assert served["text"] == twin["text"] and served["label"] != twin["label"], "the twin answers the same option at the other letter"
    assert train.main(["decision", "--data", str(data), "--min-cases", "0", "--no-promote", "--no-order-augment"]) == 0
    assert all(item["label"] == ["small talk", "a task"].index(item["text"]) for item in seen["items"]), "served order only"


def test_order_flips_counts_an_answer_that_follows_the_letter():
    import types

    cases = [train.Case("p", str(i), {}, {"type": "choice", "instructions": "i", "criteria": {"A": "x", "B": "y"}}, "A") for i in range(4)]
    stub = types.SimpleNamespace()
    real_encode, real_logits = train.encode, train.logits_of
    try:
        train.encode = lambda a, some: [{"label": 0} for _ in some]
        train.logits_of = lambda a, items: [[1.0, 0.0] for _ in items]   # always the first letter: every case flips
        assert train.order_flips(stub, cases) == {"flips": 4, "pairs": 4}
        train.logits_of = lambda a, items: [[1.0, 0.0] if i % 2 == 0 else [0.0, 1.0] for i, _ in enumerate(items)]
        assert train.order_flips(stub, cases) == {"flips": 0, "pairs": 4}, "the same option both times"
    finally:
        train.encode, train.logits_of = real_encode, real_logits
