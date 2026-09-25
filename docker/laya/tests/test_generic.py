"""/v1/decide's request logic, with a stand-in for the model."""
import pytest

from app import generic


def question(**overrides):
    base = {
        "id": "source_sensitive",
        "question": "Does answering this require checkable real-world facts?",
        "options": {"yes": "It depends on specific facts that must be verified.", "no": "General knowledge or reasoning."},
        "state": {"message": "Wie funktioniert das Pfandsystem in Dänemark?"},
    }
    return {**base, **overrides}


def test_options_reach_the_model_under_neutral_letters_in_order():
    keys, laya_question = generic.to_laya(question())
    assert keys == ["yes", "no"]
    assert laya_question == {
        "type": "choice",
        "instructions": "Does answering this require checkable real-world facts?",
        "criteria": {"A": "It depends on specific facts that must be verified.", "B": "General knowledge or reasoning."},
    }


def test_answers_come_back_under_the_callers_keys():
    seen = []

    def predict(state, questions):
        seen.append((state, questions))
        return {"answers": {"q": {"choice": "B", "probabilities": {"A": 0.2, "B": 0.8}}}, "usage": {"input_tokens": 41}}

    result = generic.decide_all(predict, [question(), question(id="second", options={"task": "A task.", "small_talk": "Small talk."})])
    assert result["answers"]["source_sensitive"] == {"choice": "no", "probabilities": {"yes": 0.2, "no": 0.8}}
    assert result["answers"]["second"] == {"choice": "small_talk", "probabilities": {"task": 0.2, "small_talk": 0.8}}
    assert result["tokens"] == 82
    # Each case is its own forward pass with its own state.
    assert seen[0][0] == {"message": "Wie funktioniert das Pfandsystem in Dänemark?"}
    assert list(seen[0][1]) == ["q"]


@pytest.mark.parametrize("body, message", [
    ({}, "body must be"),
    ({"questions": []}, "must not be empty"),
    ({"questions": [question(id="")]}, "unique string id"),
    ({"questions": [question(), question()]}, "unique string id"),
    ({"questions": [question(options={"only": "one"})]}, "options must map 2 to"),
    ({"questions": [question(options={"yes": ""})]}, "options must map 2 to"),
    ({"questions": [question(options={"a": "x", "b": " "})]}, "every option needs"),
    ({"questions": [question(state=42)]}, "state must be"),
    ({"questions": [question(state={"message": "x" * 25_000})]}, "longer than"),
    ({"questions": [question(id=str(i)) for i in range(17)]}, "at most 16"),
])
def test_rejects_what_it_cannot_answer(body, message):
    with pytest.raises(generic.BadRequest, match=message):
        generic.validate(body)
