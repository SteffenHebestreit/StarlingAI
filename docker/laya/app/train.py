"""Fine-tune the sidecar's checkpoints on the swarm's own decisions.

    python -m app.train decision [--data <export.jsonl>] [--epochs 4] [--min-cases 200]
    python -m app.train browser  [--data <export.jsonl>] [--epochs 2] [--min-cases 300]

The data is what the gateway exports from its ledgers (`pnpm --filter @starlingai/core decisions:export`): every case
the incumbent — the LLM call or rule that decides it today — answered, labelled with that answer. A run:

1. builds the cases from the questions exactly as the sidecar serves them (generic.to_laya; browser.py's jev request
   and serving transform) and encodes them with the model's own encoder path (laya's Agent._to_internal and
   _encode_state, which system_one takes), so what is trained on is token for token what will be asked;
2. holds every fifth case out (decision: by state; browser: by run, so one run's steps stay together);
3. trains with laya's RLCD recipe — a noisy-logit policy gradient on a proper scoring rule plus soft cross-entropy,
   one GPU — adapted from cklxx/laya-browser code/finetune/train.py (Apache-2.0, see NOTICE);
4. fits the choice temperature on the held-out cases and measures the held-out agreement with the incumbent of the
   checkpoint served now and of the new one. laya applies a temperature only within [0.5, 5]; a fit that wants a
   softer one than 5 has the rest folded into the decision head's last layer, a fit that wants a sharper one than 0.5
   is served at 0.5, and metrics.json says which bound was hit (temperatureFit);
5. writes LAYA_LOCAL_DIR/<model>/runs/<run id>/ with metrics.json, and makes it `current` only when it agrees with the
   incumbent more often than the checkpoint served now and no point with enough held-out cases got worse. The sidecar
   serves `current` from its next start, and the gateway's statistics start over for the new version.

Nothing here imports torch or laya at module level: the case building is tested without them.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import sys
import time
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import browser, generic, references

HOLD_OUT_EVERY = 5
MIN_HELD_OUT_PER_POINT = 20
MAX_POINT_REGRESSION = 0.03
# Rarer answers are repeated until each has at least this share of its point's most common answer (at most x4):
# a point answered "no" nine times in ten would otherwise teach "no".
BALANCE_SHARE = 1 / 3
MAX_REPEAT = 4


class TrainingError(RuntimeError):
    """The run cannot go on as asked; the message says why."""


# ── Cases: one question, its state, and the incumbent's answer ───────────────────────────────────

class Case:
    """One question as the sidecar serves it, with the answer the incumbent gave."""

    __slots__ = ("point", "group", "state", "question", "gold")

    def __init__(self, point: str, group: str, state: Any, question: Dict[str, Any], gold: str):
        self.point = point          # decision point, or "browser:<question id>"
        self.group = group          # what is held out together
        self.state = state
        self.question = question    # {"type": "choice", "instructions": ..., "criteria": {key: text}}
        self.gold = gold            # a key of question["criteria"]

    def label(self) -> int:
        return list(self.question["criteria"]).index(self.gold)


def _stable_hash(text: str) -> int:
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")


def decision_cases(rows: Iterable[Dict[str, Any]]) -> Tuple[List[Case], int]:
    """Decision-ledger export rows (scripts/decisions-export.ts) as cases; also how many rows could not be used."""
    cases: List[Case] = []
    skipped = 0
    for row in rows:
        try:
            point = row["point"]
            question = row["questions"][point]
            gold = row["gold"][point]["label"]
            state = json.loads(row["state"]) if isinstance(row["state"], str) else row["state"]
        except (KeyError, TypeError, ValueError):
            skipped += 1
            continue
        criteria = question.get("criteria") if isinstance(question, dict) else None
        if not isinstance(criteria, dict) or gold not in criteria or not isinstance(question.get("instructions"), str):
            skipped += 1
            continue
        # The question exactly as generic.to_laya serves it: options under the letters the export already uses.
        served = {"type": "choice", "instructions": question["instructions"], "criteria": dict(criteria)}
        cases.append(Case(point, json.dumps(state, sort_keys=True, ensure_ascii=False), state, served, gold))
    return cases, skipped


def _served_browser_questions(state: Dict[str, Any], questions: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """browser.predict_jev_body's transform, question by question, without the chunking: (v3 state, questions)."""
    served = {}
    for qid, question in questions.items():
        q = dict(question)
        q["instructions"] = browser.serialised_instructions(q.get("instructions"))
        q["criteria"] = {k: browser.compact(v) for k, v in q["criteria"].items()}
        served[qid] = q
    return browser.v3_state(state), served


def browser_cases(rows: Iterable[Dict[str, Any]], chunk: int, seed: int = 0) -> Tuple[List[Case], int]:
    """Browser-ledger rows where the model acted, as laya-browser cases: the operation it chose and, on an element,
    which element. A target list wider than `chunk` is cut to `chunk` around the model's element, as the sidecar
    decides it in chunks of that width."""
    cases: List[Case] = []
    skipped = 0
    for row in rows:
        model = row.get("model") if isinstance(row, dict) else None
        if not isinstance(model, dict) or row.get("decidedBy") != "model":
            skipped += 1
            continue
        operation = model.get("operation")
        observation, goal, history = row.get("observation"), row.get("goal"), row.get("history") or []
        if not isinstance(observation, dict) or not isinstance(goal, str) or not goal.strip():
            skipped += 1
            continue
        try:
            state, questions, targets, _controls = browser.build_jev_body(observation, goal, history)
        except (browser.BadRequest, KeyError, TypeError):
            skipped += 1
            continue
        if operation not in questions["operation"]["criteria"]:
            skipped += 1   # e.g. the model typed where the snapshot saw no field
            continue
        v3, served = _served_browser_questions(state, questions)
        group = str(row.get("sessionId") or row.get("ts") or "")
        cases.append(Case("browser:operation", group, v3, served["operation"], operation))
        if operation not in targets:
            continue
        node = model.get("node")
        values = [str(v) for v in model.get("values") or []]
        matches = [index for index, action in targets[operation].items()
                   if node is not None and action.get("node") == node
                   and (operation != "SELECT" or not values or str(action.get("value")) in values)]
        if len(matches) != 1:
            continue       # the model's element was not found on the page laya-browser read: train its operation only
        gold = matches[0]
        qid = operation.lower() + "_target"
        question = served[qid]
        keys = list(question["criteria"])
        if len(keys) > chunk:
            rng = random.Random(_stable_hash(f"{seed}|{group}|{row.get('ts')}|{qid}"))
            keep = set(rng.sample([k for k in keys if k != gold], chunk - 1)) | {gold}
            question = {**question, "criteria": {k: v for k, v in question["criteria"].items() if k in keep}}
        cases.append(Case(f"browser:{qid}", group, v3, question, gold))
    return cases, skipped


def split(cases: List[Case]) -> Tuple[List[Case], List[Case]]:
    """(train, held out): every fifth group is held out, whole."""
    train, held = [], []
    for case in cases:
        (held if _stable_hash(case.group) % HOLD_OUT_EVERY == 0 else train).append(case)
    return train, held


def reordered(case: Case) -> Case:
    """The case with its options in reverse order under the same letters: the answer moves with its option."""
    keys = list(case.question["criteria"])
    texts = [case.question["criteria"][key] for key in keys]
    gold = keys[len(keys) - 1 - keys.index(case.gold)]
    return Case(case.point, case.group, case.state, {**case.question, "criteria": dict(zip(keys, reversed(texts)))}, gold)


def order_augmented(cases: List[Case]) -> List[Case]:
    """Every decision case twice: as served, and with its options reversed.

    The sidecar asks a point's options in the point's order every time, so a fine-tune can learn where the answer
    sits instead of what it says. The first fine-tunes did (run 20260926-112034, decisions:bench --order-swap on its
    test half): reversing the options changed the answer in 18% of fast_lane and 40-45% of source_sensitive cases,
    where the resident model read by its letter logits changed 1 of 160. Training on both orders takes the shortcut away.
    """
    return [twin for case in cases for twin in (case, reordered(case))]


def order_flips(agent: Any, cases: List[Case]) -> Dict[str, int]:
    """How many of these cases change their answer when their options are reversed (pairs that both encode)."""
    pairs = [items for items in (encode(agent, [case, reordered(case)]) for case in cases) if len(items) == 2]
    logits = logits_of(agent, [item for pair in pairs for item in pair]) if pairs else []
    flips = 0
    for k in range(len(pairs)):
        served, reverse = logits[2 * k], logits[2 * k + 1]
        n = len(served)
        if max(range(n), key=lambda i: served[i]) != n - 1 - max(range(n), key=lambda i: reverse[i]):
            flips += 1
    return {"flips": flips, "pairs": len(pairs)}


def balanced(cases: List[Case]) -> List[Case]:
    """The training cases, rarer answers of each point repeated towards BALANCE_SHARE of the most common one."""
    counts: Dict[str, Counter] = defaultdict(Counter)
    for case in cases:
        counts[case.point][case.gold] += 1
    out: List[Case] = []
    for case in cases:
        most = max(counts[case.point].values())
        mine = counts[case.point][case.gold]
        repeat = min(MAX_REPEAT, max(1, math.ceil(BALANCE_SHARE * most / mine)))
        out.extend([case] * repeat)
    return out


def promotion(base: Dict[str, Any], tuned: Dict[str, Any]) -> Tuple[bool, str]:
    """May the new checkpoint replace the one served now? Held-out agreement with the incumbent decides."""
    if tuned["n"] == 0:
        return False, "no held-out cases"
    if tuned["accuracy"] <= base["accuracy"]:
        return False, f"held-out agreement {tuned['accuracy']:.3f} is not above the served checkpoint's {base['accuracy']:.3f}"
    for point, row in tuned["points"].items():
        before = base["points"].get(point)
        if before and row["n"] >= MIN_HELD_OUT_PER_POINT and row["accuracy"] < before["accuracy"] - MAX_POINT_REGRESSION:
            return False, f"{point} got worse: {before['accuracy']:.3f} -> {row['accuracy']:.3f}"
    return True, f"held-out agreement {base['accuracy']:.3f} -> {tuned['accuracy']:.3f}"


def read_jsonl(path: str) -> List[Dict[str, Any]]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue   # a torn last line
    return rows


# ── The model ───────────────────────────────────────────────────────────────────────────────────

def load_agent(reference: str, device: Optional[str], name: str) -> Any:
    from .models import load_reference

    agent = load_reference(reference, device)
    if name == "browser":
        browser.configure_agent(agent)
    return agent


def encode(agent: Any, cases: List[Case]) -> List[Dict[str, Any]]:
    """Token ids as system_one builds them for the case's question, with the one-hot target. A question system_one
    would refuse — options that do not fit the head — is left out: it cannot be asked, so it is not learnt."""
    items, refused = [], 0
    for case in cases:
        try:
            agent._check_question("q", case.question)
            internal = {"q": agent._to_internal(case.question)}
            item = agent._encode_state(case.state, ["q"], internal)[0]
        except ValueError:
            refused += 1
            continue
        k = len(item["markers"])
        label = case.label()
        items.append({**item, "target": [1.0 if i == label else 0.0 for i in range(k)], "label": label, "point": case.point})
    if refused:
        print(f"{refused} cases left out: their question does not fit the model's head")
    return items


def _batches(items: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def logits_of(agent: Any, items: List[Dict[str, Any]], batch_size: int = 16) -> List[List[float]]:
    import torch
    from laya.common import collate_items

    model, device = agent.model, agent.device
    model.eval()
    out: List[List[float]] = []
    with torch.no_grad():
        for group in _batches(items, batch_size):
            b = collate_items([group], agent.tok.pad_token_id)
            with torch.autocast(device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                logits, _ = model(b["input_ids"].to(device), b["attention_mask"].to(device), b["marker_pos"].to(device),
                                  b["marker_mask"].to(device), b["qtype"].to(device))
            logits = logits.float().cpu()
            for row, item in zip(logits, group):
                out.append(row[: len(item["markers"])].tolist())
    return out


def evaluate(logits: List[List[float]], items: List[Dict[str, Any]], temperature: float = 1.0) -> Dict[str, Any]:
    """Agreement with the incumbent (argmax), per point too, and the mean log loss at `temperature`."""
    points: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
    right, nll = 0, 0.0
    for z, item in zip(logits, items):
        scaled = [v / temperature for v in z]
        top = max(scaled)
        log_norm = top + math.log(sum(math.exp(v - top) for v in scaled))
        nll += log_norm - scaled[item["label"]]
        hit = int(max(range(len(z)), key=lambda i: z[i]) == item["label"])
        right += hit
        points[item["point"]][0] += hit
        points[item["point"]][1] += 1
    n = len(items)
    return {
        "n": n,
        "accuracy": right / n if n else 0.0,
        "nll": nll / n if n else 0.0,
        "points": {p: {"n": total, "accuracy": hits / total} for p, (hits, total) in sorted(points.items())},
    }


# laya applies a checkpoint's temperature only within [0.5, 5.0] (common.py TEMP_MIN / TEMP_MAX): a recorded
# temperature outside that range is clamped when the checkpoint is loaded.
TEMPERATURE_RANGE = (0.5, 5.0)
# How far the fit itself may range: well past laya's range on both sides, so that a fit wanting more than laya applies
# is seen and reported rather than silently stopped at the edge. Run 20260926-073740 (885 synthetic cases) fitted
# exactly 5.00, the old grid's edge; on its held-out logits the log loss keeps falling to 8.0 (0.336 at 5, 0.285 at 8).
FIT_RANGE = (0.05, 100.0)


def _nll(logits: List[List[float]], items: List[Dict[str, Any]], temperature: float) -> float:
    return evaluate(logits, items, temperature)["nll"]


def fit_temperature_free(logits: List[List[float]], items: List[Dict[str, Any]]) -> float:
    """The temperature that minimises the held-out log loss over FIT_RANGE: a log grid, then a golden-section search
    between the grid points around its best. The loss is convex in 1/T, so the one minimum the grid brackets is it."""
    if not items:
        return 1.0
    low, high = (math.log(bound) for bound in FIT_RANGE)
    steps = 240
    grid = [low + (high - low) * i / steps for i in range(steps + 1)]
    best = min(range(len(grid)), key=lambda i: _nll(logits, items, math.exp(grid[i])))
    a, b = grid[max(0, best - 1)], grid[min(steps, best + 1)]
    ratio = (math.sqrt(5) - 1) / 2
    for _ in range(60):
        c, d = b - ratio * (b - a), a + ratio * (b - a)
        if _nll(logits, items, math.exp(c)) <= _nll(logits, items, math.exp(d)):
            b = d
        else:
            a = c
    return math.exp((a + b) / 2)


def temperature_fit(logits: List[List[float]], items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What the held-out cases ask for (`fitted`), what laya will apply (`served`, within TEMPERATURE_RANGE), which
    bound the fit hit, and the factor folded into the decision head (`fold`) so that the checkpoint applies `effective`.

    Softening past laya's cap is folded (fold_temperature): the scorer's last layer divides every logit by `fold`, and
    laya divides by `served` on top, `fitted` in all. Sharpening past its floor is not: laya refuses to sharpen that
    hard on purpose (common.py: a 0.24 top probability published as 0.99), and so does this.
    """
    fitted = fit_temperature_free(logits, items)
    low, high = TEMPERATURE_RANGE
    served = min(high, max(low, fitted))
    bound = "upper" if fitted > high else "lower" if fitted < low else None
    fold = fitted / high if bound == "upper" else 1.0
    effective = served * fold
    return {
        "fitted": fitted,
        "served": served,
        "atBound": bound,
        "fold": fold,
        "effective": effective,
        "nll": {"atEffective": _nll(logits, items, effective), "atServedWithoutFold": _nll(logits, items, served)},
    }


def fit_temperature(logits: List[List[float]], items: List[Dict[str, Any]]) -> float:
    """The temperature laya will apply that minimises the held-out log loss: the free fit, confined to laya's range
    (the loss is unimodal in T, so the confined optimum is the free one clamped)."""
    return temperature_fit(logits, items)["served"] if items else 1.0


def fold_temperature(model: Any, factor: float) -> None:
    """Divide every choice logit of `model` by `factor` for good: the scorer ends in a linear layer
    (common.DecisionModel.scorer), so dividing its weight and bias divides its output exactly. The act head reads the
    softmax of these logits as features; its act_probability is not used here (and is 1.0 upstream, #185)."""
    import torch

    last = model.scorer[-1]
    if not isinstance(last, torch.nn.Linear):
        raise TrainingError("the decision head's scorer does not end in a linear layer: the temperature cannot be folded")
    with torch.no_grad():
        last.weight.div_(factor)
        if last.bias is not None:
            last.bias.div_(factor)


def train(agent: Any, items: List[Dict[str, Any]], epochs: int, log=print) -> None:
    """laya's RLCD recipe, single device (cklxx/laya-browser code/finetune/train.py)."""
    import torch
    from laya.common import collate_items, proper_reward

    device = agent.device
    model = agent.model
    model.train()
    if os.environ.get("LAYA_TRAIN_CHECKPOINTING", "0") == "1":
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    micro = int(os.environ.get("LAYA_TRAIN_MICRO", "4"))
    accumulate = max(1, min(8, len(items) // (micro * 8)))     # a few optimiser steps per epoch even on little data
    noise_samples, lr_encoder, lr_head, sigma_start, sigma_end = 4, 2.5e-5, 1e-4, 0.4, 0.1
    encoder_params = [p for n, p in model.named_parameters() if n.startswith("encoder.")]
    head_params = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    optimizer = torch.optim.AdamW([{"params": encoder_params, "lr": lr_encoder}, {"params": head_params, "lr": lr_head}], weight_decay=0.01)
    total = max(1, math.ceil(len(items) / (micro * accumulate)) * epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total, eta_min=1e-6)
    started, step = time.time(), 0
    order = list(items)
    for epoch in range(epochs):
        random.Random(42 + epoch).shuffle(order)
        sigma = sigma_start + (sigma_end - sigma_start) * epoch / max(1, epochs - 1)
        optimizer.zero_grad(set_to_none=True)
        losses = []
        for n, group in enumerate(_batches(order, micro), start=1):
            b = collate_items([group], agent.tok.pad_token_id)
            # Tensors to the device; collate_items also returns per-item metadata, which stays behind.
            b = {k: v.to(device) for k, v in b.items() if isinstance(v, torch.Tensor)}
            with torch.autocast(device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                logits, act = model(b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"], b["qtype"])
            logits, mask, target = logits.float(), b["marker_mask"], b["target"]
            k = mask.sum(-1, keepdim=True).float()
            eps = torch.randn((noise_samples,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                reward = proper_reward(q, target.unsqueeze(0), b["qtype"], mask, w_sph=0.75, w_rps=1.0)
                advantage = reward - reward.mean(0, keepdim=True)
                advantage = advantage / (advantage.std() + 1e-6)
            log_p = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(advantage * log_p).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + loss_ce) / accumulate + 0.0 * act.sum()
            loss.backward()
            losses.append(float(loss.item()) * accumulate)
            if n % accumulate == 0 or n * micro >= len(order):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
        log(f"epoch {epoch + 1}/{epochs}: loss {sum(losses) / max(1, len(losses)):.4f}, {step} steps, {time.time() - started:.0f}s")
    model.eval()


def save(agent: Any, out: str, run: str, temperature: float, metrics: Dict[str, Any]) -> None:
    from safetensors.torch import save_file

    os.makedirs(out, exist_ok=True)
    save_file({k: v.detach().half().contiguous().cpu() for k, v in agent.model.state_dict().items()},
              os.path.join(out, "model.safetensors"))
    agent.model.encoder.config.save_pretrained(os.path.join(out, "encoder"))
    agent.tok.save_pretrained(os.path.join(out, "tokenizer"))
    cfg = dict(agent.cfg)
    cfg.update(fine_tuned=True, starlingai_run=run, temperature=[float(temperature), 1.0, 1.0], temperature_by_options={})
    with open(os.path.join(out, "rl_agent_config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    with open(os.path.join(out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)


def promote(run_dir: str, name: str) -> str:
    """Make `run_dir` the checkpoint `name` serves: a copy in <local>/<name>/current, swapped in whole."""
    current = references.current_dir(name)
    staging, old = current + ".new", current + ".old"
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(run_dir, staging)
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(current):
        os.replace(current, old)
    os.replace(staging, current)
    shutil.rmtree(old, ignore_errors=True)
    return current


# ── The command ─────────────────────────────────────────────────────────────────────────────────

DATA = {"decision": "ledger-export.jsonl", "browser": "browser-export.jsonl"}
DEFAULT_EPOCHS = {"decision": 4, "browser": 2}
DEFAULT_MIN_CASES = {"decision": 200, "browser": 300}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.train", description=__doc__.split("\n\n")[0])
    parser.add_argument("model", choices=["decision", "browser"])
    parser.add_argument("--data", help="export JSONL (default: <LAYA_LOCAL_DIR>/data/<model export>)")
    parser.add_argument("--epochs", type=int)
    parser.add_argument("--min-cases", type=int, help="refuse to train on fewer training cases than this")
    parser.add_argument("--device", default=os.environ.get("LAYA_DEVICE") or None)
    parser.add_argument("--limit", type=int, default=0, help="use only the first N cases (a smoke run)")
    parser.add_argument("--no-promote", action="store_true", help="write the run, never make it current")
    parser.add_argument("--no-order-augment", action="store_true",
                        help="decision: train on the served option order only (an A/B against order_augmented)")
    args = parser.parse_args(argv)

    name = args.model
    data = args.data or os.path.join(references.local_dir(), "data", DATA[name])
    epochs = args.epochs or DEFAULT_EPOCHS[name]
    min_cases = DEFAULT_MIN_CASES[name] if args.min_cases is None else args.min_cases
    if not os.path.isfile(data):
        raise TrainingError(f"no training data at {data}: run `pnpm --filter @starlingai/core decisions:export` first")
    rows = read_jsonl(data)
    chunk = int(os.environ.get("LAYA_BROWSER_CHUNK", "60"))
    cases, skipped = decision_cases(rows) if name == "decision" else browser_cases(rows, chunk)
    if args.limit:
        cases = cases[: args.limit]
    train_cases, held_cases = split(cases)
    print(f"{len(rows)} rows -> {len(cases)} cases ({skipped} rows unusable): {len(train_cases)} to train on, {len(held_cases)} held out")
    print("answers:", dict(Counter(f"{c.point}={c.gold}" for c in cases).most_common(12)))
    if len(train_cases) < min_cases:
        raise TrainingError(f"{len(train_cases)} training cases, fewer than --min-cases {min_cases}: let the ledger grow first")

    served = references.reference(name)
    print(f"base: {served}")
    agent = load_agent(served, args.device, name)
    augment = name == "decision" and not args.no_order_augment
    train_items = encode(agent, order_augmented(balanced(train_cases)) if augment else balanced(train_cases))
    held_items = encode(agent, held_cases)
    base_metrics = evaluate(logits_of(agent, held_items), held_items)
    base_flips = order_flips(agent, held_cases) if name == "decision" else None
    print(f"served checkpoint, held out: {base_metrics['accuracy']:.3f} agreement over {base_metrics['n']} cases"
          + (f", {base_flips['flips']}/{base_flips['pairs']} answers change with the option order" if base_flips else ""))

    train(agent, train_items, epochs)
    held_logits = logits_of(agent, held_items)
    fit = temperature_fit(held_logits, held_items)
    temperature = fit["served"]
    tuned_metrics = evaluate(held_logits, held_items, fit["effective"])
    tuned_flips = order_flips(agent, held_cases) if name == "decision" else None
    print(f"fine-tuned, held out: {tuned_metrics['accuracy']:.3f} agreement, temperature {fit['effective']:.2f}"
          + (f", {tuned_flips['flips']}/{tuned_flips['pairs']} answers change with the option order" if tuned_flips else ""))
    if fit["atBound"]:
        low, high = TEMPERATURE_RANGE
        print(f"temperature: the held-out cases ask for {fit['fitted']:.2f}, past laya's {'upper' if fit['atBound'] == 'upper' else 'lower'} "
              f"bound ({low}-{high}); log loss {fit['nll']['atEffective']:.4f} served, {fit['nll']['atServedWithoutFold']:.4f} at the bound")
    if fit["fold"] != 1.0:
        # A fit this soft means the checkpoint is overconfident on cases it did not train on: served at laya's cap,
        # its probabilities would claim more certainty than its held-out agreement has.
        fold_temperature(agent.model, fit["fold"])
        print(f"folded x{fit['fold']:.3f} into the decision head: laya applies {temperature:.2f} to logits already divided, {fit['effective']:.2f} in all")

    run = time.strftime("%Y%m%d-%H%M%S")
    run_dir = os.path.join(references.local_dir(), name, "runs", run)
    ok, why = promotion(base_metrics, tuned_metrics)
    metrics = {"run": run, "base": served, "data": data, "cases": len(cases), "trainCases": len(train_cases),
               "heldOut": len(held_cases), "epochs": epochs, "temperature": temperature, "temperatureFit": fit,
               "served": base_metrics, "fineTuned": tuned_metrics, "promoted": ok and not args.no_promote, "why": why,
               "orderAugmented": augment, "orderFlips": {"served": base_flips, "fineTuned": tuned_flips}}
    save(agent, run_dir, run, temperature, metrics)
    print(f"wrote {run_dir}")
    if ok and not args.no_promote:
        print(f"promoted to {promote(run_dir, name)}: {why}. Restart the laya service to serve it.")
    else:
        print(f"not promoted: {why}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TrainingError as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(2)
