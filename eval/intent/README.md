# Intent bench data

The bench answers one question per facet: **does the intent readout read this facet of a request well
enough, and does it know when it does?** The readout (`packages/core/src/decisions/intent-readout.ts`)
asks every facet of the triage taxonomy in one grammar-bound call on the routing tier and reads each
facet's letter off the model's top list. Nothing consumes it yet. Before the workflow-forcing gate, the
orchestration module's inclusion or the pre-router may read it, even in shadow, each facet has to be shown
to carry signal in both languages.

```
pnpm --filter @starlingai/core intent:bench                              # the readout on every case
pnpm --filter @starlingai/core intent:bench -- --with-triage             # and the generative triage it would replace
pnpm --filter @starlingai/core intent:bench -- --order-swap              # and every case again with the options reversed
pnpm --filter @starlingai/core intent:bench -- --split test --limit 40   # a smoke run
```

The package script starts from the repository root (`cd ../.. && tsx packages/core/src/scripts/intent-bench.ts`).
Anywhere else the config loader reads the stub `packages/core/starlingai.json`, which has no routing tier,
and the script refuses to run.

## The facets

The facets are triage's IDCM taxonomy (`agent/triage.ts`, prompt `idcm-1`), in the order the readout
writes them. The options are listed in letter order.

| facet | options | what it asks |
|---|---|---|
| `mode` | converse, GATHER, PRODUCE, ACT, VERIFY, ORCHESTRATE | what the request asks the assistant to DO: the verb, never the topic |
| `domain` | research, software, authoring, data, media, device_control, comms, infra_ops, security, swarm_meta, other | the capability the work needs, not the subject; the **primary** one where two are needed |
| `deliverable` | evidence, prose_doc, deck, website, code, running_app, chart, diagram, image, data_table, plan, verdict, message, config_change, none | what the user ends up with |
| `multi` | yes, no | the request has clauses that need different capabilities |
| `alone` | yes, no | one specialist or one prebuilt workflow could finish the whole request |
| `source_sensitive` | yes, no | answering correctly needs specific, checkable real-world facts (the up-front judge's contract) |
| `decision` | answer_direct, single_agent, workflow, coordinate, clarify | the smallest path that would work |

Triage's `domain` may hold two values. A letter slot reads one, so the gold is the primary domain and
`other` means none of the ten (only a `converse` request).

## How the gold was written

Every case is **synthetic** and hand-written for this bench (2026-09-28). No message comes from a user
conversation. The labels follow the facet definitions in the readout's prefix and the rules below, never
the words used. Where the rules did not settle a facet, the case was rewritten or left out: a contested
label measures the labeller, not the model.

**mode**

- `converse`: greetings, thanks, acknowledgements, news about oneself, questions about the assistant, and
  questions answered from stable general knowledge with no tool. That covers a concept, a definition, a
  calculation on the numbers given, a joke, and general advice that depends on no current product. A
  converse request always has domain `other`, deliverable `none`, source_sensitive `no` and decision
  `answer_direct`, and `other` is used for nothing else.
- `GATHER`: find, look up, read, diagnose or analyse. When the content must first be found, the mode is
  GATHER even if the user wants it as a table ("a table of the opening hours of …" is GATHER,
  data_table). Reading the user's own mail, calendar, files, logs or systems is GATHER too.
- `PRODUCE`: make an artifact from what is given or known: text, code, an app, a chart, an image, a
  deck, a plan, a table from given data. Running code in a sandbox to get a result is PRODUCE.
- `ACT`: an effect on a system: send, book, deploy, push, delete, change a server or a repository, drive
  a browser or a desktop to do something. By convention, a change to the assistant's own agents, tools,
  prompt or durable memory is ACT with domain `swarm_meta` and deliverable `config_change`.
- `VERIFY`: judge something that exists against criteria and return a verdict: a review, a check of the
  user's text or a claim, an audit. Correcting a text is PRODUCE; saying whether it is correct is VERIFY.
- `ORCHESTRATE`: an ad-hoc request whose parts need different capabilities and a plan first. Always
  decision `coordinate` and multi `yes`.

**domain.** For a request that needs two or more capabilities, the primary domain is the one of the
part the rest depends on, normally the first step ("research the grants and make a deck" is research).
A deck or a static website is `authoring`; a web app with logic is `software`. Queries against a
database or a spreadsheet are `data`, even when the deliverable is code. `security` is authorized
offensive work under a written scope; reading about a published vulnerability is `research`, and
reviewing one's own configuration is `infra_ops`.

**deliverable.** The final thing the user gets.

- A mail, chat message, SMS or reminder text, drafted or sent, is `message`. A letter, an article, a
  summary, a translation, a corrected text or a poem is `prose_doc`.
- A to-do list, a project plan or a test plan is `plan`.
- An action that leaves nothing to hand over (a meeting booked, a form submitted, a server restarted, old
  mails deleted) is `none`, like small talk. A changed setting or rule is `config_change`, and a
  deployment is `running_app`.

**multi and alone.**

- `multi` is `yes` when at least two clauses need different capabilities. Several steps within one
  capability are not multi, and a greeting in front of a request is not a clause.
- `alone` is `no` exactly when the decision is `coordinate`. A direct answer, a clarification and a
  workflow are all `yes`: nothing needs splitting, or one prebuilt pipeline covers it.

**source_sensitive.** The rules of `eval/decisions/README.md` (*source_sensitive labels*): judge the
subject, not the phrasing.

- `yes`: prices, statistics, laws, deadlines, current events, what a named organisation or product does
  now, how a particular real scheme works, and which product or version is best or latest.
- `no`: concepts, calculations on given numbers, code, writing, the user's own text, the assistant
  itself, and follow-ups that change something already produced.
- A request not to look anything up changes nothing: the subject still needs the fact.
- New here: reading the user's own mail, calendar, files, logs or systems is `no`. The answer is in the
  user's data, not in facts about the world.

**decision.**

- `answer_direct`: the whole answer fits in the reply, written from the message and general knowledge,
  with no lookup, no file, no rendering, no execution and no external effect. That covers every converse
  request and short writing: a translation, a rewrite, a summary of pasted text, a poem, a small code
  snippet. A source-sensitive request is never answer_direct.
- `single_agent`: one specialist capability does all of it: any lookup, a rendered artifact (image,
  chart, diagram, deck, website, running app), work on files or code in a project, or an external effect.
- `workflow`: the request asks for a standard, repeatable procedure by its shape ("as every Monday",
  "the usual release process", "wie immer"). It is labelled multi `yes` when its steps cross
  capabilities. Its mode is the one of its final effect: sending is ACT, a document is PRODUCE, a check is
  VERIFY.
- `coordinate`: an ad-hoc request that needs a plan first. Either its parts cross a specialist boundary,
  or it takes many steps (40 services to migrate, 27 countries to compare).
- `clarify`: a goal or a required input is missing and nothing supplies it ("Übersetz das mal bitte."
  with no text and no earlier turn). The verb still fixes the mode, domain and deliverable. A request
  that is merely broad is not clarify.

**Follow-ups.** A case may carry `prior`, the two-line digest of the turn before, which triage and the
readout receive as triage's `priorTurnDigest`. The follow-up is labelled in its light: "und jetzt in rot"
after a logo is PRODUCE, media, image. The same short message with no `prior` and no referent is
`clarify`.

## The file

One JSON object per line; lines starting with `//` are comments.

```json
{"id":"in-de-104","language":"de","message":"...","prior":"User: ...\nAssistant: ...","gold":{"mode":"PRODUCE","domain":"media","deliverable":"image","multi":"no","alone":"yes","source_sensitive":"no","decision":"single_agent"},"tags":["follow-up","short"]}
```

`intent.example.jsonl` holds 312 cases: 174 German (56%) and 138 English. Every value of a facet with up
to six options has at least 8 cases, and every domain and deliverable at least 4. The cases are
**enriched** with the rare values (clarify, workflow, coordinate, ORCHESTRATE, VERIFY), so accuracy on live
traffic weighs the common values more.

Tags name the hard cases, and each appears in both languages:

| tag | kind of case |
|---|---|
| `follow-up`, `short`, `one-word`, `confirm` | a short follow-up, with the prior turn in `prior` |
| `mixed` | a mixed request whose parts need different capabilities |
| `small-talk-plus-request` | polite small talk that also asks something |
| `do-not-look-up` | "ohne nachzuschauen": source-sensitive when the subject needs the fact, not otherwise |
| `brand-in-passing` | a brand named in a message that is not about it |
| `own-text` | a request about the user's own text or data |
| `vague`, `no-context` | a request that needs clarification |
| `routine` | a standard multi-step procedure asked for by its shape (decision workflow) |
| `many-steps` | one capability with too many steps for one pass (decision coordinate) |
| `about-assistant`, `concept`, `calculation`, `writing`, `code-snippet` | requests best answered directly, with no specialist |

A deployment can keep its own cases in `intent.jsonl` beside the example. The bench prefers that file,
and git ignores it (`.gitignore` here), because it would hold real users' messages.

### Adding cases

1. Write the message in the user's voice and label every facet by the rules above.
2. Use the next free id of the language (`in-de-175`, `in-en-139`) and never reuse one. A case's
   calibration or test half is derived from its id.
3. Tag the kind.
4. Run `npx vitest run src/tests/intent-bench.test.ts` in `packages/core`. It checks the lint, the counts
   above, the tags in both languages, both halves, and the rules that are fixed: converse if and only if
   domain `other`; no answer_direct when source-sensitive; alone `no` if and only if coordinate;
   ORCHESTRATE only as coordinate with multi.

## Running it

- **The readout** is `askIntentReadout` itself, on the routing tier the source judge uses
  (`SAI_PRIMARY_MODEL_URL` from `.env`, the tier's model selector). Thinking is off, the GBNF grammar is
  sent, and the sampling temperature is 0 by default: at 0.7 a runner-up written at `mode` would change
  what the later slots are read after.
- **Triage** (`--with-triage`) is `runTriage` with the turn's own call shape and its 8-second bound
  (`--triage-timeout-ms`). A call still running when triage gives up is aborted, so that it does not run
  on beside the next case. The two arms alternate which goes first.
- **Order swap** (`--order-swap`) asks every case once more after the main pass. Each facet's options
  are reversed, so the option under A is now under the last letter. The grammar is unchanged; the prefix
  is a different one, and so the pass runs after the main pass rather than interleaved with it.
- **One case at a time**, one call after another. One untimed warm-up call per prefix comes first. A
  server that refuses the grammar or sends no top list shows it on that call, and the run stops there.
- **What is never written:** the gateway's audit log and ledgers. Output goes to
  `.starlingai/live-check/intent-bench/<timestamp>/` (or `--out`):
  - `report.json` and `report.md`;
  - `audit.jsonl`, this run's provider calls;
  - `rows.jsonl`, one row per case and pass. **It holds the messages**, so keep it local.

  No file holds the readout's or triage's English restatement, only its length.

| flag | default | meaning |
|---|---|---|
| `--cases <jsonl>` | `intent.jsonl`, else the example | case files; may be given more than once |
| `--with-triage` | off | also run the generative triage on each case |
| `--order-swap` | off | ask every case again with each facet's options reversed |
| `--split all\|calibration\|test` | all | run one half only |
| `--limit n` | all | n of the selected cases, spread over the file by a hash of their ids (the same n every run), not its first n lines |
| `--top-logprobs` | 20 | alternatives per token (the deliverable facet has 15 letters) |
| `--min-mass` | 0.5 | the least probability the letters must hold on a slot's list |
| `--sampling-temperature` | 0 | the readout's sampling temperature |
| `--triage-timeout-ms` | 8000 | triage's bound, the turn's |
| `--timeout-ms` | 60000 | per readout call |

Exit codes:

| code | meaning |
|---|---|
| 0 | no facet fails: each holds, or too few calls were asked to judge it (inconclusive) |
| 1 | a facet fails (verdicts below); or no top list arrived at all |
| 2 | a usage mistake, or nothing could be judged (no readout answered; every facet inconclusive: fewer than 20 answered calls, or none in a language) |
| 3 | the environment is suspect: the routing tier is unreachable, the warm-up call failed, or more than a fifth of an arm's calls failed or timed out |

pnpm reports every non-zero code as 1, so the verdict is also printed.

The verdict per facet, in the order it is decided:

| verdict | when | fails the run |
|---|---|---|
| `inconclusive` | fewer than 20 calls answered, or none in one language: too little was asked | no |
| `unread` | the calls answered, but the facet was read on fewer than half of one language's calls, or on fewer than 20 in all | yes |
| `below_majority` | accuracy no better than the always-majority answer, in both languages together **or in either one** | yes |
| `below_triage` | triage right significantly more often on the cases only one got right (exact McNemar p < 0.05) | yes |
| `unproven` | better than the constant answer, but not significantly: exact McNemar p ≥ 0.05 on the cases only one of the two got right. A facet whose gold is 92% `yes` is 93% right by one case | yes |
| `holds` | none of the above | no |

A facet read on fewer than 90% of a language's calls holds with a warning: its accuracy is on the replies
that could be read.

## Reading the report

**Per language** (German, English, both): whether each readout call came back with a token list, the
failures, wall ms p50/p90, tokens generated, and the prompt tokens llama-server processed and reused
from its cache. Also how often the restatement came back non-empty: for the readout, whose grammar
demands one, and for triage, whose prompt leaves it empty for English. Last, how many readouts detected
a language other than the labelled one. Such a case would look its temperature up under another bucket.

**Per facet and language:**

- how often the facet was read, and why not;
- accuracy against gold with its Wilson lower bound, beside the **always-majority** baseline on the same
  readings (in-sample: the most a constant answer could score here), and the two paired case by case: only
  the readout right, only the constant right, the exact McNemar p;
- with triage: triage's accuracy, both on the cases both answered, the discordant pairs with the exact
  McNemar p, and how often the two agree (what a shadow run would count);
- ECE on the test half at T = 1 and at a temperature fitted on the calibration half. The halves are split
  by a hash of the case id, so the "after" figure is never read off the cases that fitted it;
- coverage and accuracy at top ≥ 0.85 and 0.95 and at a margin ≥ 0.15 and 0.5. The full curves over
  every level are below each table;
- with `--order-swap`: how often the choice changed, and the mean change of the first choice's
  probability;
- the recall per gold value and the confusion matrix (rows gold, columns the readout; only the rows and
  columns in use).

The curves are at T = 1, the model's own distribution. The margin binds only where the top threshold is
below (1 + margin) / 2: at a top of 0.85 the margin is at least 0.70 anyway (see `DEFAULT_CONFIDENCE`).

**Temperatures.** Each facet and language gets a temperature fitted on every reading against gold,
given twice. The language is the bucket the readout detected (`de`, `en` or `other`), since that is the
one it looks a temperature up under; a short message such as "ok cool" is detected as `other`:

- as `askIntentReadout`'s `temperatures`;
- as a `decisions.readout.temperatures` snippet under the keys `intent.<facet>`.

Nothing reads those config keys yet. A fit that ends at the range's edge is left out.

## Not measured here

- **Real traffic.** The cases are synthetic, and the mix is enriched with the rare values.
- **The readout among a turn's calls.** Here each call runs alone. Whether llama-server keeps the
  readout's prefix cached while the orchestrator uses the same server depends on its slot settings
  (`-np`, `-sps`), which this bench does not change.
- **Hysteresis across turns.** Each case is one message, with at most the prior turn's digest.
