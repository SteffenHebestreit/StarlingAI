/**
 * What the turn recorded, for the QA verdict: the files its tools produced, with the engine, tier
 * and model each producing tool wrote down, and what the user typed this turn.
 *
 * Without this the prose verdict sees the plan's acceptance criteria and the answer, and both are
 * the orchestrator's own account. In session f4ebf47b record_plan's only criterion was about style
 * and had dropped the user's "nimm das qwen model". The answer said the picture was "generiert mit
 * dem Qwen-Modell", the file's metadata said tier fast, model image, and the loop spent 85 s
 * passing it.
 *
 * INVARIANT: imports only leaf modules, so runtime.ts can use it without a cycle.
 */
import { collectArtifactRecords } from "./artifact-metadata.js";
import { userWordsLines, type TurnUserWords } from "./delegation-user-words.js";
import { formatDelegatedRunRecord } from "./tool-result-format.js";
import { currentTurnStartIndex, type TurnBoundaryMessage } from "./turn-boundary.js";

const USER_WORDS_HEADER = "The user's own words this turn, verbatim:";
const ATTRIBUTION_RULE = "An answer that attributes a file to an engine, tier or model other than the one recorded above FAILS.";
const CONSTRAINT_RULE = "An answer that ignores a constraint the user stated in these words (a model, tier, format, "
  + "language, something to avoid) without saying so FAILS.";

/**
 * The block the verdict prompt carries after the criteria, or "" when the turn produced no file and
 * no words of the user's are known (a scene or job template is not the user's words, so such a
 * turn has none). A rule is stated only for what is shown: the attribution rule only when some
 * file has an engine, tier or model on record.
 */
export function formatQaTurnRecord(
  history: ReadonlyArray<TurnBoundaryMessage>,
  words: TurnUserWords | undefined,
): string {
  const toolMetadata = history.slice(currentTurnStartIndex(history) + 1)
    .filter((message) => message.role === "tool" && message.metadata && typeof message.metadata === "object")
    .map((message) => message.metadata as Record<string, unknown>);
  // One list for the whole turn, read by the walker the orchestrator's own frames use. A direct
  // tool result (generate_image puts outputPath, tier and model at the top of its metadata) and a
  // delegation frame (which nests them under `artifacts`) read alike, and a path written twice is
  // listed once, as its later write.
  const turn = { artifacts: toolMetadata };
  const files = formatDelegatedRunRecord(turn);
  const attributed = files !== ""
    && collectArtifactRecords(turn).some((record) => record.engine || record.tier || record.model);
  const said = userWordsLines(words);
  if (!files && said.length === 0) return "";
  const rules = [attributed ? ATTRIBUTION_RULE : "", said.length > 0 ? CONSTRAINT_RULE : ""].filter(Boolean).join(" ");
  return [
    "",
    ...(files ? [files] : []),
    ...(said.length > 0 ? [USER_WORDS_HEADER, ...said] : []),
    ...(rules ? [rules] : []),
  ].join("\n");
}
