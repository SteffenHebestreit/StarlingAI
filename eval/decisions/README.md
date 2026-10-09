# Decision bench data

The bench answers one question per decision point: **does handing the decision to Laya save time
without losing the cases that matter?** It runs every labelled case through the point's incumbent
(the routing-tier call a turn makes today) and through the Laya sidecar, one after the other, and
reports:

- **Accuracy per arm.** Both arms are scored against the gold label, and Laya is also scored
  against the incumbent. Every slice shows precision and recall per answer.
- **Baselines.** Each slice shows the always-majority baseline next to those scores.
- **Gate replay.** The adaptive gate is replayed on held-out cases. It reports coverage, the
  error rate among the cases Laya would take, and the **rare-class miss rate**.
- **Projected savings.** The seconds saved per 100 turns, as a share of the time to the
  orchestrator's first token and of a whole turn without image renders.

```
pnpm --filter @starlingai/core decisions:bench                               # both points, the example cases
pnpm --filter @starlingai/core decisions:bench --points source_sensitive --repeat 3
pnpm --filter @starlingai/core decisions:bench --no-laya                     # the incumbent against gold only
pnpm --filter @starlingai/core decisions:bench --no-incumbent                # Laya against gold; gate replayed against gold
```

The package script has to start from the repository root: `cd ../.. && tsx
packages/core/src/scripts/decisions-bench.ts`. Anywhere else, the config loader reads
`packages/core/starlingai.json`. That file is a stub with no receptionist, no routing tier and no
model address, so the incumbent would be a call no turn makes. The script refuses to run there.

## Why agreement is not enough

The adaptive gate (`packages/core/src/decisions/gate.ts`) hands Laya an answer once Laya agrees
with the incumbent often enough on that answer. That measures the **precision** of the answer
Laya gives.

On the 25 attributed turns of 2026-09-21..25, the source judge said "clear" 25 times out of 25. On
that traffic a Laya that always says "no" agrees every time. Precision alone would qualify it,
and it would then miss every source-sensitive question.

Where a point names a protected answer (`protect` in `decisions/points.ts`: "yes" for
source_sensitive), the gate therefore also requires Laya's **recall** of that answer before it
takes any other answer: among the cases the incumbent answered "yes", in the same language and
for the same checkpoint, Laya may have said "no" at that confidence so rarely that the lower bound
of the recall reaches the target, over at least `minSamples` such cases. fast_lane protects
nothing, because a miss there costs time, not quality: its gate checks precision only.

So the bench:

- replays the gate with that recall guard, exactly as `gate.ts` runs it;
- counts the misses on the rare class where they happen;
- replays the gate for an always-majority Laya, to show whether the gate would be fooled;
- uses datasets that are **enriched** with the rare class. Recall cannot be measured on cases
  that do not contain the class.

The enrichment inflates how often the rare class occurs. The projection is therefore also
**reweighted** to a traffic prior (see *Projection* below).

## The datasets

| file | point | cases | German | rare class |
|---|---|---|---|---|
| `fast_lane.example.jsonl` | fast_lane (receptionist) | 216, 7 of them `gated` | 58% | small_talk 41% |
| `source_sensitive.example.jsonl` | source_sensitive (up-front judge) | 196 | 58% | yes 39% |
| `negation.example.jsonl` | both, `--negation` only | 44: 22 negation minimal pairs | 50% | – |

Both are **synthetic** and hand-written for this bench (2026-09-26). No message comes from a user
conversation. Gold follows the point's definition in `packages/core/src/decisions/points.ts` and
the incumbent's own prompt. Gold never follows the words used.

One JSON object per line. Lines starting with `//` are comments.

```json
{"id":"ss-de-001","point":"source_sensitive","language":"de","state":{"message":"..."},"gold":"yes","tags":["price"]}
```

- `state` is what Laya reads, built as the turn builds it: `{ message }`. The source judge cuts
  the message at 2,000 characters; the bench does the same.
- `gold` must be one of the point's option keys.
- `tags` name the kind of case. The tests require every near-miss kind below in both languages.

A deployment can keep its own cases in `fast_lane.jsonl` and `source_sensitive.jsonl` next to the
examples. The bench prefers those files, and git ignores them (`.gitignore` here), because they
hold real users' messages.

### fast_lane labels

The question the point asks: is this small talk that the front desk can answer in one or two
sentences from what it knows about itself, or a task? The rules come from `FAST_LANE` and the
receptionist prompt in `agent/receptionist.ts`.

| gold | when |
|---|---|
| `small_talk` | Greetings, thanks, goodbyes and acknowledgements ("ok", "passt", 👍, "sorry, my bad"), including an emoji-only reply. Also how-are-you, questions about the assistant itself (name, what it is, who built it, its favourite film), what it can do in broad terms ("Kannst du auch Bilder erstellen?"), and news about oneself that asks for nothing ("Hab heute Geburtstag"). |
| `task` | Anything that asks to do, find, create, check, compute, explain, translate or look something up, however short: "wetter morgen?", "Erzähl mir einen Witz", "Tschüss auf Italienisch?". Questions about the **user** ("Wie heiße ich?", "Welche Termine habe ich morgen?"): the front desk has no access to their data. Follow-ups that ask for a change or confirm an action ("nochmal", "ja, mach das so", "und jetzt in rot"). Small talk with a request inside it ("Hallo! Wie viel ist 2 hoch 10?"). |

Near-miss kinds (tags):

- `small-talk-plus-request`: a greeting or thanks with a request attached.
- `brand-in-passing`: a brand named in small talk ("Grüße aus dem ICE nach München").
- `do-not-look-up`: "Du musst nichts nachschauen, sag einfach hallo zurück" is small talk, while
  "Schau nichts nach, nur: Hauptstadt von Kanada?" is a task.
- `own-text`: the user's own text, to be checked.
- `casual-fact`: a fact question asked casually.
- `about-user`, `typo`, `one-word`, `follow-up`.

The front desk hands its model **only** messages of at most 120 characters and 12 words, with no
URL and no standing instruction (`classifyFrontDesk`). Longer messages never reach the model or
Laya. Cases tagged `gated` exist to prove the bench skips them. The bench records them as gated
and asks neither arm. A test checks that the real gate refuses exactly the `gated` cases.

### source_sensitive labels

The question the point asks: does answering this well need specific, checkable real-world facts
that must be looked up rather than recalled? The rules come from `SOURCE_SENSITIVE` and the judge
prompt in `agent/ungrounded-claim-judge.ts`. Judge the **subject**, not the phrasing.

| gold | when |
|---|---|
| `yes` | A price, fee, rate or statistic. A law, rule, deadline or dosage. A date or a current event. What a named organisation, company, product or brand does now. How a **particular** real system, scheme, service or place works ("Wie funktioniert die Förderung für Wärmepumpen in Deutschland?"). Which real product, tool or version is best, latest or recommended, which includes which programming language to learn and which Node.js release is LTS. A writing task whose content needs such facts ("Einspruch ... mit den aktuellen Fristen"). Checking a real-world fact in the user's own text. The same holds when the user says not to look anything up: the subject still needs the fact. |
| `no` | A concept in principle ("Wie funktioniert eine Wärmepumpe?", "Was bedeutet Inflation?"), a definition, reasoning, a calculation on numbers given, code, a writing or image task, general advice that does not depend on a current product, the user's own content (summarise, translate, proofread), small talk, the assistant itself, and follow-ups that change something already produced. A research verb does not make it `yes` ("Recherchier mal, was Rekursion ist"), and neither does a brand named in passing ("Schreib ein Gedicht über meinen alten VW Golf"). |

Near-miss kinds (tags):

- `brand-in-passing`, `do-not-look-up`, `lookup-verb`.
- `own-text`: the user's text, either to process or to fact-check.
- `casual-fact`, `typo`, `one-word`, `follow-up`.

### Adding cases

1. Write the message in the user's voice and label it by the rules above, not by its words. When
   the rules do not settle a case, leave it out: a contested gold label measures the labeller's
   opinion, not the model.
2. Use the next free id of the file and language (`fl-de-126`, `ss-en-084`) and never reuse one.
   A case's calibration or test half is derived from its id, so renaming a case can move it into
   the half a fine-tuned checkpoint was trained on.
3. Tag the kind. A fast_lane message the front desk would refuse must be tagged `gated`.
4. Run `npx vitest run src/tests/decisions-bench.test.ts` in `packages/core`. It checks:
   - the lint;
   - at least 120 scored cases;
   - at least 55% German;
   - at least 35% rare class, and at least 25 rare cases in each language;
   - the near-miss kinds in both languages;
   - the front-desk gate for fast_lane.

## Running it

- **Incumbent.** The production path, run from the repository root:
  - The address comes from `SAI_PRIMARY_MODEL_URL` in `.env` (llama-swap), with the routing
    tier's model selector.
  - The prompts and parsers are the incumbents' own, reused from `decisions:bootstrap`:
    `labelFastLane` (front-desk gate, prompt, escalation rule) and `labelSourceSensitive`.
    Neither touches the decision layer.
  - Every provider row the call produces is captured. The report shows retries and failovers as
    calls per decision, and shows llama-server's own `timings` (prompt tokens processed,
    prompt tokens reused from cache, prompt and decode milliseconds) once the provider records
    them.
- **Laya.** `askLaya` from `decisions/laya-client.ts` itself, so the question, the options, the
  state and the timeout (`decisions.timeoutMs`) are the ones a turn sends. The default
  `--laya-url` is `http://127.0.0.1:18080`, for example the GPU image run with
  `--gpus all -p 127.0.0.1:18080:8080`. Measure on the GPU Laya will really run on, next to the
  reranker it shares that GPU with.
- **One case at a time.** The two arms alternate which goes first, and one untimed warm-up call
  per arm and point comes before the first case.
- **What is never written.** The gateway's audit log and its decision ledger. Output goes to
  `.starlingai/live-check/decisions-bench/<timestamp>/` (or `--out`):
  - `rows.jsonl`: one row per case in the decision ledger's format, plus the gold label, case
    id, half, attempt and incumbent timings. **It holds the messages**, so keep it local.
    `decisions:report --ledger <dir>/rows.jsonl` reads it like a ledger.
  - `report.json` and `report.md`.
  - `audit.jsonl`: this run's provider calls.

| flag | default | meaning |
|---|---|---|
| `--points` | both | `fast_lane`, `source_sensitive` |
| `--cases <jsonl>` | per point: own file, else example | one case file (may hold both points) |
| `--repeat k` | 1 | runs per case; repeats feed latency and the incumbent's own consistency, never the gate |
| `--split all\|calibration\|test` | all | run one half only |
| `--target`, `--min` | `decisions.adaptive` (0.9, 30) | gate settings |
| `--audit-rate` | `decisions.adaptive.auditRate` (0.1) | share of Laya's qualified cases still sent to the incumbent |
| `--max-rare-miss` | 0.1 | where a miss costs quality: the most misses of the rare class tolerated |
| `--frequency p=x,…` | fast_lane 0.6, source_sensitive 1 | decisions per turn |
| `--prior p=x,…` | fast_lane 0.059, source_sensitive 0.037 | rare-class share of real traffic |
| `--train-out <jsonl>` | – | write the calibration half in the fine-tuning format (see below) |
| `--no-incumbent`, `--no-laya` | – | skip an arm |
| `--negation` | – | also run the negation minimal pairs of `negation.example.jsonl` for the selected points (below) |
| `--order-swap` | – | ask Laya every case a second time with the point's options in reverse order (below) |

Exit codes:

| code | meaning |
|---|---|
| 0 | judged, and no point is unsafe |
| 1 | a point's replayed gate would take cases it gets wrong, or lose too much of the rare class |
| 2 | a usage mistake, or nothing could be judged: no Laya answer, a language without a scored case, or a calibration half too small to qualify anything |
| 3 | the environment is suspect: a backend is unreachable, or more than a fifth of an arm's calls failed |

pnpm reports every non-zero code as 1, so the verdict is also printed.

## Reading the report

**Per language.** German, English and both together, for each point and Laya checkpoint:

- accuracy of each arm against gold, and Laya's agreement with the incumbent;
- recall of the rare class for both arms, next to the always-majority baseline;
- median latency of each arm.

**Gate replay.** Cases are split into two halves by a hash of their id.

- *Calibration.* Confidence levels are qualified on this half exactly as `gate.ts` qualifies them:
  - per detected language (the bucket a turn uses, so a bare "ok" lands in `other`) and per Laya
    answer;
  - the levels are tested from the highest down, and the first whose Wilson lower bound misses
    `--target` ends the sequence: the lowest level reached is the one qualified. The lowest level
    is tested from `--min` cases, every higher one only once it holds 200 at a target of 0.9
    (`levelSampleFloor` in `gate.ts`); a level with fewer is skipped, not failed;
  - the level must also qualify without the newest three cases, and the newest 100 at that level
    must agree at the target less 0.03 at least (0.87 at 0.9), and right after 100 that did not,
    at the target itself (the gate's confirmation and drift window). The gate reads
    order, so the calibration half is fed to it in an order hashed from the case ids, the same
    every run;
  - for source_sensitive, "no" must also pass the recall guard: at least `--min` calibration
    cases in the same language whose reference was "yes", with a lower bound of Laya's "yes"
    recall at that level that reaches `--target`. Each bucket line shows how many "yes" cases
    the guard had and on how many of them Laya said "no";
  - only answers the point lets Laya take can be taken. fast_lane lets Laya take only `task`,
    because only the model can write the small-talk reply.
- *Test.* The qualified levels are applied to the other half. Coverage, the error rate among the
  cases taken, and the rare-class miss rate come from this half.
- *One run per case.* Repeats are not independent evidence.
- *Minimum sample.* At a target of 0.9, qualifying needs **38** agreeing cases: 35 for the Wilson
  bound (30 agreeing out of 30 is only 0.886), and the same again without the newest three. With
  one disagreement it is 53 and 56. The recall guard needs 35 "yes" cases, all found. With about
  100 cases per point and language, a calibration half holds 20 to 40 per answer, so the verdict
  is often *inconclusive*. That describes the real gate's data needs. It is not a bench defect. On
  live traffic where the judge says "yes" rarely, the guard keeps "no" with the incumbent until 35
  "yes" turns per language have been seen. A level above the lowest needs 200 cases before it is
  tested at all, so a half this size can only qualify the lowest level.
- *Level curve.* Coverage, errors and rare-class misses for one fixed confidence level over every
  case. It is descriptive: no level is chosen from it.

**Projection**, on the test half:

- *Concurrent*: incumbent and Laya start together, as `decide()` does where no answer of the point
  has qualified. A taken case saves the incumbent's time minus Laya's. A case that is not taken
  costs nothing, unless Laya is the slower of the two.
- *Laya-first* starts the incumbent only when Laya's answer is not taken, as `decide()` does once
  an answer has qualified (`decisions.layaFirstMs`, at most 80 ms of waiting). It adds Laya's time
  to every case that is not taken. In exchange, the GPU never gets an incumbent request that is
  started and then aborted (E5, 2026-09-26: such an abort made the next call on the same model
  952 ms slower).
- The audited share (`--audit-rate`) goes to the incumbent in both orders.
- For fast_lane, small talk that Laya sends on as a task costs the full path instead of the front
  desk's reply. The penalty is 8.2 s, the p50 time to the orchestrator's first token. For
  source_sensitive a miss costs answer quality, not time. It is counted as rare misses per 100
  turns.
- Each projection is reported twice:
  - with the cases mixed as the dataset mixes them;
  - reweighted to the rare class's traffic prior. **This one is the headline.**

Every default comes from the 25 attributed turns of 2026-09-21..25: one user, image requests
only. They are thin, so override them with `--frequency` and `--prior` when better numbers exist:

| default | value | source |
|---|---|---|
| receptionist p50 | 1,844 ms | attributed turns |
| judge p50 | 1,819 ms | attributed turns |
| time to first token p50 | 8.2 s | attributed turns |
| non-render turn p50 | 46.7 s | attributed turns |
| frequency | fast_lane 15/25, judge 25/25 | turns the point ran on |
| priors | small talk 0/15, "yes" 0/25 | observed, plus one pseudo-case on each side |

**Verdicts:**

| verdict | when |
|---|---|
| `unsafe` | what the gate takes disagrees with the reference (the incumbent, or gold with `--no-incumbent`) more often than `1 - target` allows. For source_sensitive, also: Laya takes more than `--max-rare-miss` of the `yes` cases (gold `yes` or the incumbent's `yes`) the other way. |
| `inconclusive` | no scored case in a language, or the calibration half is too small to qualify anything, counting the "yes" cases the recall guard needs |
| `no_payoff` | nothing qualified, or the reweighted projection saves no time |
| `pays_off` | none of the above |

## Negation pairs and option order

Laya's checkpoints are known to read past a negation: upstream issue #377 has "please do NOT
cancel" answered as cancel_account at 0.9998. `negation.example.jsonl` holds 22 pairs of cases,
11 per point, German and English. The two cases of a pair differ by where a negation sits
(nicht, kein, nichts; not, no, don't):

- *flip* pairs: the negation changes what is asked, and the gold labels differ ("Nicht den
  aktuellen Leitzins, nur was ein Leitzins ist." is `no`; "Den aktuellen Leitzins, nicht nur was
  ein Leitzins ist." is `yes`);
- *control* pairs: it changes nothing that is asked, and the gold labels are the same.

`--negation` adds them to a run. Both arms answer them, and the report shows per point and
language how many flip pairs each arm got both right and how many it answered the same way twice
(it read past the negation), and how many control pairs it answered the same way (as it should).
The pairs take no part in the gate replay, the projection, the verdict or `--train-out`, and
`--split` keeps each pair whole.

`--order-swap` asks Laya every case a second time with the point's options in reverse order, so
the option under the letter A is now under B. A choice that changes with the order was the
order's, not the case's; upstream measured 22.5% of choices on a public set. The report shows the
flip rate and the mean change of the first answer's probability per point and language.

## Fine-tuning on the calibration half

```
pnpm --filter @starlingai/core decisions:bench --train-out .starlingai/laya/data/bench-calibration.jsonl
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile laya run --rm laya \
  python -m app.train decision --data /models/local/data/bench-calibration.jsonl --min-cases 100
# restart the sidecar, then score the new checkpoint on cases it never saw:
pnpm --filter @starlingai/core decisions:bench --split test
```

- **Labels.** The calibration half is labelled by the incumbent, as the ledger would label it.
  The gold labels stay out of training.
- **Nested split.** A run on one half splits that half again to replay the gate. The report says
  so.
- **Trainer minimums.** The trainer holds out every fifth case of its data and refuses fewer than
  `--min-cases` training cases (200 by default). About 100 per point is below that default, which
  is why the command passes `--min-cases 100`.

## Not measured here

- **Memory capsule and name.** The receptionist's prompt on a real turn also carries the memory
  capsule (up to 400 characters) and the assistant's name. `labelFastLane` leaves both out, so
  its prompt is up to about 100 tokens shorter than a real one.
- **Whole turns.** The time a whole turn takes and whether it succeeds come from the end-to-end
  pass^k runs (`agents:evaluate --via-gateway`), not from this bench.
- **Interactions between points.** A fast-lane answer skips the source judge. The two
  projections are per point and must not simply be added to each other or to the savings of
  other levers, such as a reranker warm-up or running the judge in parallel with the
  receptionist.
