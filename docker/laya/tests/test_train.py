"""Fine-tuning data: cases built from the gateway's exports exactly as the sidecar serves the questions, the held-out
split, the balancing and the promotion rule — everything short of the model itself, so no torch is needed."""
import json

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
