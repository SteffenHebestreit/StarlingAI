"""Generic decisions: one choice question per case, answered with a probability per option.

The caller's option keys ("yes", "task", "disagree" …) are not what the model reads. Each option is shown under a
neutral letter with its description ("A: It depends on specific real-world facts …"): laya is measurably biased by
yes/no-like label words (issue #156), so the meaning goes in the description and the answer is mapped back to the
caller's key afterwards. The order of the options is kept as sent — option order is part of what a fine-tuned model
learns, so it must not vary between requests.

A question may ask for its own window ("max_len", in tokens; at most MAX_WINDOW): the gateway's finding_relevant check
sends the 6,000 characters its extraction reads, which the checkpoint's default window of 1024 tokens cuts. Every
answer says which window it was read with ("maxLen") and how many tokens of the state that window cut off
("truncatedTokens") — laya does not report either, and the gateway keeps a point's evidence per window.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MAX_QUESTIONS = 16
MAX_OPTIONS = 20          # accuracy falls off past ~20 options (laya README)
MAX_STATE_CHARS = 20_000  # well past the widest window (MAX_WINDOW tokens); anything longer is cut by the model anyway
MAX_TEXT_CHARS = 4_000
# laya-multilingual reads up to 8,192 tokens and is strong to about 4,000; past that its latency is erratic (laya 0.3.18+).
MAX_WINDOW = 4_096
# The question and its options take up to the checkpoint's head_max_len (192) plus three special tokens, and laya
# drops an option marker a window cuts, then refuses the question ("options exceed head_max_len") with a 500. A window
# below 256 is refused here instead, as the caller's mistake it is: at 64 or 128 a long question loses its markers.
MIN_WINDOW = 256


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
        window = q.get("max_len")
        if window is not None and (isinstance(window, bool) or not isinstance(window, int) or window < MIN_WINDOW):
            raise BadRequest(f"{qid}: max_len must be a whole number of tokens, at least {MIN_WINDOW}")
    return questions


def window_of(question: Dict[str, Any]) -> Optional[int]:
    """The window a question asks for, bounded at MAX_WINDOW; None for the checkpoint's own."""
    window = question.get("max_len")
    return None if window is None else min(int(window), MAX_WINDOW)


def to_laya(question: Dict[str, Any]) -> tuple[list[str], Dict[str, Any]]:
    """The caller's keys in order, and the laya choice question with the options under neutral letters."""
    keys = list(question["options"].keys())
    criteria = {LETTERS[i]: question["options"][key] for i, key in enumerate(keys)}
    return keys, {"type": "choice", "instructions": question["question"], "criteria": criteria}


Predict = Callable[[Any, Dict[str, Any], Optional[int]], Dict[str, Any]]


def decide_all(predict: Predict, questions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Every question answered. `predict(state, {qid: question}, max_len)` is laya's `system_one` with the question's
    window (None: the checkpoint's own), as app/window.py measures it: its result may also carry the window used
    ("window") and, per question, the tokens that window cut ("truncated_tokens")."""
    answers: Dict[str, Any] = {}
    tokens = 0
    for question in questions:
        keys, laya_question = to_laya(question)
        result = predict(question["state"], {"q": laya_question}, window_of(question))
        answer = result["answers"]["q"]
        probabilities = {keys[LETTERS.index(letter)]: float(p) for letter, p in answer["probabilities"].items()}
        choice = keys[LETTERS.index(answer["choice"])]
        entry: Dict[str, Any] = {"choice": choice, "probabilities": probabilities}
        if isinstance(result.get("window"), int):
            entry["maxLen"] = result["window"]
        truncated = (result.get("truncated_tokens") or {}).get("q")
        if isinstance(truncated, int):
            entry["truncatedTokens"] = truncated
        answers[question["id"]] = entry
        tokens += int(result.get("usage", {}).get("input_tokens", 0))
    return {"answers": answers, "tokens": tokens}
