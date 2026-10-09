"""A decision with the window it was read through: laya's `system_one`, plus what laya itself does not report.

laya cuts a state that does not fit its window without a word (upstream #174, #181; `laya.serve` even ignores max_len,
#549): a list state keeps its tail, a dict or a string its head. The gateway hands finding_relevant the 6,000
characters its extraction reads, so it must know when Laya answered a case it did not read to the end — the answer
then counts for less than it seems, and the ledger row says so.

The count comes from laya's own encoder path (Agent._encode_state, which system_one takes) run once more without a
bound: the sequence as it would be with nothing cut, against the window. When the state is cut, the sequence fills the
window exactly (common.build_sequence), so the difference is the number of tokens that were cut.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

# Longer than any state validate() lets through, so nothing is cut.
UNBOUNDED = 1_000_000_000


def window_used(agent: Any, max_len: Optional[int]) -> int:
    """The window a call reads through: the question's own, else the checkpoint's (rl_agent_config.json max_len)."""
    return int(max_len) if max_len is not None else int(agent.cfg.get("max_len", 512))


def truncated_tokens(agent: Any, state: Any, questions: Dict[str, Dict[str, Any]], window: int) -> Dict[str, int]:
    """Per question, how many tokens `window` cuts off the sequence system_one builds for it."""
    ids = list(questions)
    internal = {qid: agent._to_internal(questions[qid]) for qid in ids}
    full = agent._encode_state(state, ids, internal, max_len=UNBOUNDED)
    return {qid: max(0, len(item["ids"]) - window) for qid, item in zip(ids, full)}


def system_one_measured(agent: Any, state: Any, questions: Dict[str, Dict[str, Any]], max_len: Optional[int] = None) -> Dict[str, Any]:
    """`agent.system_one` through the question's window, with the window used and the tokens it cut per question."""
    result = agent.system_one(state, questions, max_len=max_len)
    window = window_used(agent, max_len)
    return {**result, "window": window, "truncated_tokens": truncated_tokens(agent, state, questions, window)}
