"""A question's own window: forwarded to system_one, bounded, reported with the tokens it cut — with a stand-in for the
model, and against laya's own sequence builder where laya is installed (the image, a dev venv)."""
import types

import pytest

from app import generic, window


def question(**overrides):
    base = {
        "id": "finding_relevant",
        "question": "Does this content hold anything relevant to the objective?",
        "options": {"relevant": "At least one fact that serves the objective.", "irrelevant": "Only page chrome or other subjects."},
        "state": {"objective": "Deposit on a can in Denmark", "content": "x" * 10_000},
    }
    return {**base, **overrides}


class CharAgent:
    """laya's Agent as far as window.py reads it: one token per character, a head of `head` tokens, the checkpoint's
    window in cfg — the arithmetic of common.build_sequence, which cuts the state to fill the window exactly."""

    def __init__(self, cfg_max_len=1024, head=40):
        self.cfg = {"max_len": cfg_max_len}
        self.head = head
        self.asked = []

    def _to_internal(self, q):
        return {"t": q["type"], "ins": q["instructions"], "crit": q["criteria"]}

    def _encode_state(self, state, ids, internal, max_len=None, head_max_len=None):
        max_len = self.cfg["max_len"] if max_len is None else max_len
        state_tokens = len(str(state))
        room = max(0, max_len - self.head - 1)
        return [{"ids": [0] * (self.head + min(state_tokens, room) + 1)} for _ in ids]

    def system_one(self, state, questions, max_len=None):
        self.asked.append(max_len)
        return {"answers": {qid: {"choice": "A", "probabilities": {"A": 0.7, "B": 0.3}} for qid in questions},
                "usage": {"input_tokens": 1}}


def run(agent, questions):
    return generic.decide_all(lambda state, qs, max_len: window.system_one_measured(agent, state, qs, max_len), questions)


def test_the_window_asked_for_reaches_system_one_bounded_at_4096():
    agent = CharAgent()
    result = run(agent, [question(max_len=2_048), question(id="wide", max_len=8_192), question(id="default")])
    assert agent.asked == [2_048, generic.MAX_WINDOW, None]
    assert generic.MAX_WINDOW == 4_096
    assert result["answers"]["finding_relevant"]["maxLen"] == 2_048
    assert result["answers"]["wide"]["maxLen"] == 4_096, "a wider window than the cap is read through the cap, and says so"
    assert result["answers"]["default"]["maxLen"] == 1_024, "no window asked for: the checkpoint's own, reported"


def test_the_tokens_a_window_cut_are_counted_on_a_10k_character_state():
    agent = CharAgent(cfg_max_len=1_024, head=40)
    state = question()["state"]
    full = 40 + len(str(state)) + 1
    result = run(agent, [question(max_len=4_096), question(id="default"), question(id="short", state={"objective": "x", "content": "y"})])
    assert result["answers"]["finding_relevant"]["truncatedTokens"] == full - 4_096
    assert result["answers"]["default"]["truncatedTokens"] == full - 1_024
    assert result["answers"]["short"]["truncatedTokens"] == 0


@pytest.mark.parametrize("bad", [0, 32, 128, 255, -1, "4096", 4096.0, True])
def test_a_window_that_is_not_a_whole_number_of_tokens_or_cannot_hold_the_question_is_refused(bad):
    with pytest.raises(generic.BadRequest, match="max_len"):
        generic.validate({"questions": [question(max_len=bad)]})


def test_the_count_matches_laya_s_own_sequence_builder():
    """With laya installed: its Agent._encode_state and common.build_sequence, a character tokenizer, a 10k state."""
    agent_module = pytest.importorskip("laya.agent")

    class CharTokenizer:
        mask_token, mask_token_id, cls_token_id, sep_token_id, pad_token_id = "[MASK]", 1, 2, 3, 0

        def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
            ids = [10 + (ord(c) % 1000) for c in text]
            return {"input_ids": ids[:max_length] if truncation and max_length else ids}

    fake = types.SimpleNamespace(cfg={"max_len": 1_024, "head_max_len": 256}, tok=CharTokenizer())
    q = generic.to_laya(question())[1]
    internal = {"q": {"t": q["type"], "ins": q["instructions"], "crit": q["criteria"]}}
    encode = agent_module.Agent._encode_state

    class Bound:
        cfg = fake.cfg
        tok = fake.tok
        _to_internal = staticmethod(lambda qdef: internal["q"])
        _encode_state = lambda self, *a, **k: encode(fake, *a, **k)  # noqa: E731

    state = question()["state"]
    for max_len in (1_024, 2_048, 4_096):
        used = len(encode(fake, state, ["q"], internal, max_len=max_len)[0]["ids"])
        full = len(encode(fake, state, ["q"], internal, max_len=window.UNBOUNDED)[0]["ids"])
        assert used == max_len, "a cut state fills the window exactly"
        assert window.truncated_tokens(Bound(), state, {"q": q}, max_len) == {"q": full - used}
