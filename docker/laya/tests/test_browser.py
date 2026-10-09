"""/v1/browser/step's request building, with a stand-in for the model.

The request must be what laya-browser was trained on: jev-ultrafast's choose() body, then the v3 serving transform.
"""
import json
from pathlib import Path

from app import browser
from app.jev_questions import NEXT_ACTION, OPERATION_LABELS, TARGET

FIXTURE = Path(__file__).parent / "fixtures" / "laya_browser_sample_request.json"

OBSERVATION = {
    "url": "https://example.org/flights",
    "title": "Flights",
    "text": "Find flights. " + "x" * 3000,
    "actions": [
        {"id": "e1", "kind": "click", "node": 11, "role": "link", "label": "Home"},
        {"id": "e2", "kind": "fill", "node": 12, "role": "combobox", "label": "Where from?", "value": "Zürich"},
        {"id": "e3", "kind": "click", "node": 12, "role": "combobox", "label": "Open Where from?"},
        {"id": "e4", "kind": "select", "node": 13, "role": "combobox", "label": "Class → Business", "value": "business", "current_value": "Economy"},
        {"id": "e5", "kind": "click", "node": 14, "role": "checkbox", "label": "One way", "checked": "false"},
        {"id": "scroll_down", "kind": "scroll", "label": "Scroll down", "delta": 560},
        {"id": "press_enter", "kind": "key", "label": "Press Enter in the focused text field (submit it)", "key": "Enter"},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ],
}


def test_builds_jevs_request_with_operations_in_training_order():
    state, questions, targets, controls = browser.build_jev_body(OBSERVATION, "Book a one-way flight from Zürich", [])
    assert list(questions["operation"]["criteria"]) == ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_DOWN", "PRESS_ENTER", "WAIT", "DONE", "BLOCKED"]
    assert questions["operation"]["criteria"]["CLICK"] == OPERATION_LABELS["CLICK"]
    assert questions["operation"]["instructions"] == {"goal": "Book a one-way flight from Zürich", "rules": NEXT_ACTION}
    # One index per element: the combobox fills and opens under the same index.
    assert questions["click_target"]["criteria"]["2"] == {"element": "[2] Open Where from?", "current_value": "", "role": "combobox"}
    assert questions["type_text_target"]["criteria"]["2"]["current_value"] == "Zürich"
    assert questions["select_target"]["criteria"] == {"3:1": {"element": "[3:1] Class → Business", "current_value": "Economy", "role": "combobox"}}
    assert questions["click_target"]["instructions"] == {"goal": "Book a one-way flight from Zürich", "operation": "CLICK", "rules": [NEXT_ACTION, TARGET]}
    assert targets["CLICK"]["4"]["id"] == "e5"
    assert set(controls) == {"SCROLL_DOWN", "PRESS_ENTER", "WAIT"}
    assert [e["label"] for e in state["elements"]] == ["Home", "Where from?", "Class", "One way"]


def test_compacts_criteria_like_format_v3():
    assert browser.compact({"element": "[5] Where from?", "current_value": "Zurich", "role": "combobox"}) == "[5] Where from? (combobox) = 'Zurich'"
    assert browser.compact({"element": "[1] " + "L" * 80, "role": "link"}) == "[1] " + "L" * 46 + " (link)"
    assert browser.compact({"element": "[4] One way", "checked": "false", "role": "checkbox"}) == "[4] One way (checkbox) checked=false"
    assert browser.compact("already a string") == "already a string"


def test_serves_the_v3_state_and_ascii_instructions():
    calls = []

    def predict(state, questions):
        calls.append((state, questions))
        return {"answers": {qid: {"choice": next(iter(q["criteria"])), "probabilities": {k: 1 / len(q["criteria"]) for k in q["criteria"]}}
                            for qid, q in questions.items()}, "usage": {"input_tokens": 100}}

    step = browser.decide_step(predict, OBSERVATION, "Book a one-way flight from Zürich", [{"action": "Home", "kind": "click", "text": None, "page_changed": True, "extra": 1}])
    state, questions = calls[0]
    assert set(state) == {"page", "recent_actions"}
    assert len(state["page"]["text"]) == 1200
    assert state["recent_actions"] == [{"action": "Home", "kind": "click", "text": None, "page_changed": True}]
    # Instructions go as the ASCII JSON laya 0.3.4 made of the dict the model was trained with.
    assert questions["operation"]["instructions"] == json.dumps({"goal": "Book a one-way flight from Zürich", "rules": NEXT_ACTION})
    assert "\\u00fc" in questions["operation"]["instructions"]
    assert questions["type_text_target"]["criteria"]["2"] == "[2] Where from? (combobox) = 'Zürich'"
    assert step["operation"] == "CLICK"
    assert step["target"]["actionId"] == "e1" and step["target"]["node"] == 11
    assert step["passes"] == 1


def test_decides_a_wide_choice_coarse_to_fine():
    observation = {"url": "u", "title": "t", "text": "", "actions": [
        {"id": f"e{i}", "kind": "click", "node": i, "role": "link", "label": f"Result {i}"} for i in range(1, 8)
    ]}

    def predict(state, questions):
        answers = {}
        for qid, q in questions.items():
            keys = list(q["criteria"])
            # Scores favour the highest element number; the operation is always CLICK.
            weights = {k: (int(k) if k.isdigit() else (5 if k == "CLICK" else 1)) for k in keys}
            total = sum(weights.values())
            probabilities = {k: w / total for k, w in weights.items()}
            answers[qid] = {"choice": max(probabilities, key=probabilities.get), "probabilities": probabilities}
        return {"answers": answers, "usage": {"input_tokens": 10}}

    step = browser.decide_step(predict, observation, "open the last result", [], chunk=3)
    assert step["passes"] == 2
    assert step["target"]["index"] == "7"
    assert abs(sum(a["probability"] for a in step["target"]["alternatives"]) - 1) < 0.2
    assert step["target"]["alternatives"][0]["index"] == "7"


def test_leaves_excluded_actions_out_and_names_a_control():
    def predict(state, questions):
        return {"answers": {qid: {"choice": "SCROLL_DOWN" if qid == "operation" else next(iter(q["criteria"])),
                                  "probabilities": {k: (0.9 if k == "SCROLL_DOWN" else 0.1 / (len(q["criteria"]) - 1)) if qid == "operation" else 1 / len(q["criteria"]) for k in q["criteria"]}}
                            for qid, q in questions.items()}, "usage": {}}

    seen = []
    step = browser.decide_step(lambda s, q: seen.append(q) or predict(s, q), OBSERVATION, "scroll", [], excluded=["e1"])
    assert all("Home" not in str(c) for c in seen[0]["click_target"]["criteria"].values())
    assert step["operation"] == "SCROLL_DOWN"
    assert step["control"] == {"actionId": "scroll_down", "kind": "scroll", "label": "Scroll down", "delta": 560}
    assert step["target"] is None


def test_serves_the_published_sample_request_unchanged_but_for_v3():
    sample = json.loads(FIXTURE.read_text(encoding="utf-8"))
    seen = []

    def predict(state, questions):
        seen.append((state, questions))
        return {"answers": {qid: {"choice": next(iter(q["criteria"])), "probabilities": {k: 1 / len(q["criteria"]) for k in q["criteria"]}}
                            for qid, q in questions.items()}, "usage": {"input_tokens": 1}}

    browser.predict_jev_body(predict, sample["state"], sample["questions"], 60)
    state, questions = seen[0]
    assert state == browser.v3_state(sample["state"])
    for qid, question in sample["questions"].items():
        assert questions[qid]["criteria"] == question["criteria"], qid
        assert questions[qid]["instructions"] == json.dumps(question["instructions"])
