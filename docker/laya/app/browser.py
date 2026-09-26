"""One browser step decided by laya-browser (cklxx/laya-browser, v15s).

The request is built exactly as the model was trained on:

- `build_jev_body` is jev-ultrafast's `action_space` + `choose` request (browser-use/jev-ultrafast, model.py, MIT) —
  one index per observed element, one target question per operation, the operation question over the targets'
  operations, the observed controls (scroll, wait, press enter) and DONE / BLOCKED, in that order.
- `predict_jev_body` is laya-browser's serving transform (cklxx/laya-browser, code/apps/systemone_server.py,
  Apache-2.0, format v3): each target criterion compacted to one short string, the page text cut to 1200
  characters, the element table dropped from the state, and a choice wider than the chunk size decided coarse to
  fine in two passes.

Instructions are passed pre-serialised with `json.dumps` (ASCII escapes), which is what laya 0.3.4 did to the dict
instructions the model was trained with; newer laya versions serialise dicts differently, a string they leave alone.
See NOTICE.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from .jev_questions import BLOCKED_LABEL, DONE_LABEL, NEXT_ACTION, OPERATION_LABELS, TARGET

KIND_TO_OPERATION = {"click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT"}
PAGE_TEXT_CHARS = 1200   # format v3
ELEMENT_CHARS = 50       # format v3
MAX_HISTORY = 10


class BadRequest(ValueError):
    """The request cannot be answered as sent."""


def configure_agent(agent: Any) -> None:
    """laya-browser checkpoints record the head budget they were trained with (systemone_server.py): serve and
    train with it."""
    trained = agent.cfg.get("head_max_len_train")
    if trained:
        agent.cfg["head_max_len"] = trained


# ── jev-ultrafast: the request ────────────────────────────────────────────────────────────────────

def action_space(actions: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Dict[str, Any]]], Dict[str, Dict[str, Any]]]:
    """One index per observed element; each operation has its own valid target choices (jev model.py, verbatim logic)."""
    elements: List[Dict[str, Any]] = []
    indices: Dict[Any, str] = {}
    targets: Dict[str, Dict[str, Dict[str, Any]]] = {}
    controls: Dict[str, Dict[str, Any]] = {}
    for action in actions:
        kind = action["kind"]
        if kind not in KIND_TO_OPERATION:
            controls[action["id"].upper()] = action
            continue
        node = action["node"]
        if node not in indices:
            index = str(len(elements) + 1)
            indices[node] = index
            element = {k: action[k] for k in ("role", "value", "checked", "selected", "expanded") if k in action}
            element.update(index=index, label=action["label"].split(" → ")[0], operations=[])
            if kind == "select":
                element["value"] = action.get("current_value", "")
                element["options"] = []
            elements.append(element)
        index = indices[node]
        operation = KIND_TO_OPERATION[kind]
        group = targets.setdefault(operation, {})
        element = elements[int(index) - 1]
        if operation not in element["operations"]:
            element["operations"].append(operation)
        target = index
        if kind == "select":
            target = f"{index}:{len(element['options']) + 1}"
            element["options"].append({"index": target, "label": action["label"], "value": action["value"]})
        group[target] = action
    return elements, targets, controls


def build_jev_body(observation: Dict[str, Any], goal: str, history: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Dict[str, Dict[str, Any]]], Dict[str, Dict[str, Any]]]:
    """jev's `choose` request for one observed page: (state, questions, targets, controls)."""
    actions = observation.get("actions")
    if not isinstance(actions, list):
        raise BadRequest("observation.actions must be the list the snapshot script returned")
    elements, targets, controls = action_space(actions)
    operations: Dict[str, str] = {key: OPERATION_LABELS[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(DONE=DONE_LABEL, BLOCKED=BLOCKED_LABEL)
    questions: Dict[str, Any] = {
        "operation": {"type": "choice", "criteria": operations, "instructions": {"goal": goal, "rules": NEXT_ACTION}},
    }
    for operation, candidates in targets.items():
        questions[operation.lower() + "_target"] = {
            "type": "choice",
            "criteria": {
                index: {
                    "element": f"[{index}] {a['label']}",
                    "current_value": a.get("current_value", a.get("value", "")),
                    **{k: a[k] for k in ("role", "checked", "selected", "expanded") if k in a},
                }
                for index, a in candidates.items()
            },
            "instructions": {"goal": goal, "operation": operation, "rules": [NEXT_ACTION, TARGET]},
        }
    state = {
        "page": {k: observation.get(k, "") for k in ("url", "title", "text")},
        "elements": elements,
        "recent_actions": [{k: h.get(k) for k in ("action", "kind", "text", "page_changed")} for h in history[-MAX_HISTORY:]],
    }
    return state, questions, targets, controls


# ── laya-browser: the serving transform ───────────────────────────────────────────────────────────

def compact(value: Any) -> Any:
    """One jev element criterion as one short string, format v3 (systemone_server.py `compact`)."""
    if isinstance(value, dict) and "element" in value:
        text = str(value["element"])[:ELEMENT_CHARS]
        if value.get("role"):
            text += f" ({value['role']})"
        if value.get("current_value"):
            text += f" = {str(value['current_value'])[:30]!r}"
        for key in ("checked", "selected", "expanded"):
            if key in value:
                text += f" {key}={value[key]}"
        return text
    return value


def v3_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """The state as format v3 reads it: page text cut, element table dropped."""
    page = state.get("page") if isinstance(state, dict) else None
    if isinstance(page, dict) and isinstance(page.get("text"), str):
        return {"page": {**page, "text": page["text"][:PAGE_TEXT_CHARS]}, "recent_actions": state.get("recent_actions", [])}
    return state


def serialised_instructions(instructions: Any) -> Any:
    """Dict or list instructions as laya 0.3.4 serialised them for training: `json.dumps`, ASCII escapes."""
    return json.dumps(instructions) if isinstance(instructions, (dict, list)) else instructions


Predict = Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]


def predict_jev_body(predict: Predict, state: Dict[str, Any], questions: Dict[str, Any], chunk: int) -> Dict[str, Any]:
    """laya-browser's `predict`: compact criteria, v3 state, and a choice wider than `chunk` split into interleaved
    chunks whose winners compete in a second pass; p(option) = p_final(its chunk's winner) * p_chunk(option).

    `predict(state, questions)` is one forward pass over several questions (laya's `system_one`)."""
    state = v3_state(state)
    first: Dict[str, Any] = {}
    plan: Dict[str, Tuple[Dict[str, Any], List[List[str]]]] = {}
    for qid, question in questions.items():
        question = dict(question)
        question["instructions"] = serialised_instructions(question.get("instructions"))
        if isinstance(question.get("criteria"), dict):
            question["criteria"] = {k: compact(v) for k, v in question["criteria"].items()}
        keys = list(question["criteria"]) if question["type"] == "choice" and isinstance(question.get("criteria"), dict) else []
        if len(keys) <= chunk:
            first[qid] = question
            continue
        n = -(-len(keys) // chunk)
        chunks = [keys[i::n] for i in range(n)]
        plan[qid] = (question, chunks)
        for ci, part in enumerate(chunks):
            first[f"{qid}__chunk{ci}"] = {**question, "criteria": {k: question["criteria"][k] for k in part}}
    result = predict(state, first)
    answers = result["answers"]
    tokens = int(result.get("usage", {}).get("input_tokens", 0))
    passes = 1
    if plan:
        chunk_answers = {qid: [answers.pop(f"{qid}__chunk{ci}") for ci in range(len(chunks))] for qid, (_, chunks) in plan.items()}
        finals = {qid: {**question, "criteria": {a["choice"]: question["criteria"][a["choice"]] for a in chunk_answers[qid]}}
                  for qid, (question, _) in plan.items()}
        second = predict(state, finals)
        passes = 2
        tokens += int(second.get("usage", {}).get("input_tokens", 0))
        for qid, (_, chunks) in plan.items():
            final = second["answers"][qid]
            probabilities: Dict[str, float] = {}
            for chunk_answer, part in zip(chunk_answers[qid], chunks):
                p_winner = final["probabilities"][chunk_answer["choice"]]
                for key in part:
                    probabilities[key] = p_winner * chunk_answer["probabilities"][key]
            total = sum(probabilities.values()) or 1.0
            probabilities = {k: v / total for k, v in probabilities.items()}
            answers[qid] = {"type": "choice", "choice": max(probabilities, key=probabilities.get), "probabilities": probabilities}
    return {"answers": answers, "passes": passes, "tokens": tokens}


# ── One step ──────────────────────────────────────────────────────────────────────────────────────

TOP_TARGETS = 5


def decide_step(predict: Predict, observation: Dict[str, Any], goal: str, history: List[Dict[str, Any]],
                excluded: Optional[List[str]] = None, chunk: int = 60) -> Dict[str, Any]:
    """The next operation and, for a targeted one, the element — named by the caller's own action id and node."""
    if not isinstance(goal, str) or not goal.strip():
        raise BadRequest("goal must be a non-empty string")
    if not isinstance(history, list):
        raise BadRequest("history must be a list")
    if excluded:
        observation = {**observation, "actions": [a for a in observation.get("actions", []) if a.get("id") not in set(excluded)]}
    state, questions, targets, controls = build_jev_body(observation, goal, history)
    result = predict_jev_body(predict, state, questions, chunk)
    answers = result["answers"]
    operation_answer = answers["operation"]
    operation = operation_answer["choice"]
    step: Dict[str, Any] = {
        "operation": operation,
        "operationProbability": float(operation_answer["probabilities"][operation]),
        "operationProbabilities": {k: float(v) for k, v in operation_answer["probabilities"].items()},
        "target": None,
        "control": None,
        "passes": result["passes"],
        "tokens": result["tokens"],
    }
    if operation in targets:
        target_answer = answers[operation.lower() + "_target"]
        index = target_answer["choice"]
        action = targets[operation][index]
        ranked = sorted(target_answer["probabilities"].items(), key=lambda kv: kv[1], reverse=True)[:TOP_TARGETS]
        step["target"] = {
            "index": index,
            "actionId": action["id"],
            "node": action.get("node"),
            "kind": action["kind"],
            "label": action.get("label", ""),
            "role": action.get("role"),
            **({"value": action["value"]} if "value" in action else {}),
            "probability": float(target_answer["probabilities"][index]),
            "alternatives": [
                {"index": k, "actionId": targets[operation][k]["id"], "node": targets[operation][k].get("node"),
                 "label": targets[operation][k].get("label", ""), "probability": float(p)}
                for k, p in ranked
            ],
        }
    elif operation in controls:
        control = controls[operation]
        step["control"] = {"actionId": control["id"], "kind": control["kind"], "label": control.get("label", ""),
                           **({"delta": control["delta"]} if "delta" in control else {}),
                           **({"key": control["key"]} if "key" in control else {})}
    return step
