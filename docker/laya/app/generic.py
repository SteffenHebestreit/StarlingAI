"""Generic decisions: one choice question per case, answered with a probability per option.

The caller's option keys ("yes", "task", "disagree" …) are not what the model reads. Each option is shown under a
neutral letter with its description ("A: It depends on specific real-world facts …"): laya is measurably biased by
yes/no-like label words (issue #156), so the meaning goes in the description and the answer is mapped back to the
caller's key afterwards. The order of the options is kept as sent — option order is part of what a fine-tuned model
learns, so it must not vary between requests.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MAX_QUESTIONS = 16
MAX_OPTIONS = 20          # accuracy falls off past ~20 options (laya README)
MAX_STATE_CHARS = 20_000  # the window is ~1024 tokens; anything longer is cut by the model anyway
MAX_TEXT_CHARS = 4_000


class BadRequest(ValueError):
    """The request cannot be answered as sent."""


def validate(body: Any) -> List[Dict[str, Any]]:
    if not isinstance(body, dict) or not isinstance(body.get("questions"), list):
        raise BadRequest("body must be {\"questions\": [...]}")
    questions = body["questions"]
    if not questions:
        raise BadRequest("questions must not be empty")
    if len(questions) > MAX_QUESTIONS:
        raise BadRequest(f"at most {MAX_QUESTIONS} questions per request")
    seen = set()
    for q in questions:
        if not isinstance(q, dict):
            raise BadRequest("every question must be an object")
        qid, text, options, state = q.get("id"), q.get("question"), q.get("options"), q.get("state")
        if not isinstance(qid, str) or not qid or qid in seen:
            raise BadRequest("every question needs a unique string id")
        seen.add(qid)
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise BadRequest(f"{qid}: question must be a non-empty string of at most {MAX_TEXT_CHARS} characters")
        if not isinstance(options, dict) or not 2 <= len(options) <= MAX_OPTIONS:
            raise BadRequest(f"{qid}: options must map 2 to {MAX_OPTIONS} keys to descriptions")
        if not all(isinstance(k, str) and k and isinstance(v, str) and v.strip() for k, v in options.items()):
            raise BadRequest(f"{qid}: every option needs a key and a description")
        if not isinstance(state, (dict, list, str)):
            raise BadRequest(f"{qid}: state must be an object, a list or a string")
        if len(str(state)) > MAX_STATE_CHARS:
            raise BadRequest(f"{qid}: state is longer than {MAX_STATE_CHARS} characters")
    return questions


def to_laya(question: Dict[str, Any]) -> tuple[list[str], Dict[str, Any]]:
    """The caller's keys in order, and the laya choice question with the options under neutral letters."""
    keys = list(question["options"].keys())
    criteria = {LETTERS[i]: question["options"][key] for i, key in enumerate(keys)}
    return keys, {"type": "choice", "instructions": question["question"], "criteria": criteria}


Predict = Callable[[Any, Dict[str, Any]], Dict[str, Any]]


def decide_all(predict: Predict, questions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Every question answered; `predict(state, {qid: question})` is laya's `system_one`."""
    answers: Dict[str, Any] = {}
    tokens = 0
    for question in questions:
        keys, laya_question = to_laya(question)
        result = predict(question["state"], {"q": laya_question})
        answer = result["answers"]["q"]
        probabilities = {keys[LETTERS.index(letter)]: float(p) for letter, p in answer["probabilities"].items()}
        choice = keys[LETTERS.index(answer["choice"])]
        answers[question["id"]] = {"choice": choice, "probabilities": probabilities}
        tokens += int(result.get("usage", {}).get("input_tokens", 0))
    return {"answers": answers, "tokens": tokens}
