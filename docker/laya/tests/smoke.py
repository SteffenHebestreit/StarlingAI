"""Smoke test with the real checkpoints; run inside the image: python -m tests.smoke

1. laya-browser v14s on its own published sample step must answer the recorded operation (TYPE_TEXT; the model
   card's reference gives p=0.92 on this step).
2. The generic decision model must answer two yes/no cases under the caller's keys. Zero-shot accuracy is NOT
   checked here — the stock checkpoint is not expected to make these decisions well before it is fine-tuned.
"""
import json
import sys
import time
from pathlib import Path

from app import browser, generic
from app.server import MODELS

FIXTURE = Path(__file__).parent / "fixtures" / "laya_browser_sample_request.json"


def timed(label, fn):
    started = time.perf_counter()
    result = fn()
    print(f"{label}: {(time.perf_counter() - started) * 1000:.0f} ms", flush=True)
    return result


def main() -> int:
    failures = 0
    sample = json.loads(FIXTURE.read_text(encoding="utf-8"))
    model = MODELS["browser"]
    timed("load browser model", model.load)
    predict = lambda state, qs: model.run(lambda agent: agent.system_one(state, qs))  # noqa: E731
    result = timed("browser step (cold)", lambda: browser.predict_jev_body(predict, sample["state"], sample["questions"], 60))
    result = timed("browser step (warm)", lambda: browser.predict_jev_body(predict, sample["state"], sample["questions"], 60))
    operation = result["answers"]["operation"]
    print("browser operation:", operation["choice"], {k: round(v, 3) for k, v in operation["probabilities"].items()}, "passes", result["passes"], "tokens", result["tokens"])
    if operation["choice"] != sample["expected"]["operation"]:
        print("FAIL: expected", sample["expected"]["operation"])
        failures += 1

    decision = MODELS["decision"]
    timed("load decision model", decision.load)
    questions = [
        {"id": "de", "question": "Does answering this require specific, checkable real-world facts that must be looked up?",
         "options": {"yes": "It depends on specific real-world facts that must be verified.", "no": "General knowledge, reasoning or small talk."},
         "state": {"message": "Wie funktioniert das Pfandsystem in Dänemark und wer betreibt es?"}},
        {"id": "en", "question": "Does answering this require specific, checkable real-world facts that must be looked up?",
         "options": {"yes": "It depends on specific real-world facts that must be verified.", "no": "General knowledge, reasoning or small talk."},
         "state": {"message": "Thanks, that was helpful!"}},
    ]
    generic.validate({"questions": questions})
    answers = timed("two generic decisions", lambda: generic.decide_all(lambda s, q: decision.run(lambda a: a.system_one(s, q)), questions))
    for qid, answer in answers["answers"].items():
        print("decision", qid, answer)
        if set(answer["probabilities"]) != {"yes", "no"} or answer["choice"] not in ("yes", "no"):
            print("FAIL: answer not under the caller's keys")
            failures += 1
    print("devices:", {name: m.status()["device"] for name, m in MODELS.items()})
    print("SMOKE", "FAILED" if failures else "PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
