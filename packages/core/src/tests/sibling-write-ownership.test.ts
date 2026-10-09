import { describe, expect, it } from "vitest";
import {
  SiblingWriteGroup,
  checkSiblingWrite,
  extractTaskNamedPaths,
  runAsWriteSibling,
} from "../agent/sibling-write-ownership.js";

/**
 * C5' (c): WRITE OWNERSHIP AMONG CONCURRENTLY RUNNING SIBLINGS — the rule itself.
 *
 * c297c5ea: a run_task_graph ran three builders whose tasks named three different files; the
 * write_paper builder edited the deck twice while write_presentation built it and never wrote
 * paper.md. These drive the rule through the same async-context scope the fan-outs use; the
 * fan-out wiring is in delegation-loop-consequences.test.ts and the loop's refusal in
 * sub-agent-sibling-write.test.ts.
 */

const WS = "/workspace";

/** Runs `bodies` as concurrently running siblings of one group; each body sees the others running. */
async function siblings(
  group: SiblingWriteGroup,
  members: Array<{ id: string; task: string; body: () => Promise<unknown> | unknown }>,
): Promise<unknown[]> {
  let arrived = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  return Promise.all(members.map((member) =>
    runAsWriteSibling(group, member.id, `node '${member.id}'`, member.task, async () => {
      arrived += 1;
      if (arrived === members.length) release();
      await allStarted;
      return member.body();
    })));
}

describe("the files a task names", () => {
  it("are its path-shaped tokens, in any language, and not a URL's path", () => {
    expect(extractTaskNamedPaths("Schreibe das Paper nach paper.md und die Notizen nach notes/notes.md.").sort())
      .toEqual(["notes/notes.md", "paper.md"]);
    expect(extractTaskNamedPaths("Use https://revealjs.com/api/index.html as the reference; no files.")).toEqual([]);
  });
});

describe("write ownership among running siblings", () => {
  it("a file a sibling's task names is refused to the others, and the refusal names the owner", async () => {
    const group = new SiblingWriteGroup("run_task_graph", WS);
    const [paper, deck] = await siblings(group, [
      { id: "write_paper", task: "Write the paper to paper.md.", body: () => [checkSiblingWrite("deck.html"), checkSiblingWrite("paper.md")] },
      { id: "write_presentation", task: "Build the deck in deck.html.", body: () => [checkSiblingWrite("deck.html")] },
    ]) as Array<Array<ReturnType<typeof checkSiblingWrite>>>;
    expect(paper![0]).toEqual({ owner: "node 'write_presentation'", kind: "run_task_graph" });
    expect(paper![1]).toBeNull();
    expect(deck![0]).toBeNull();
  });

  it("compares files after the workspace resolver: generated/deck.html IS deck.html", async () => {
    const group = new SiblingWriteGroup("run_task_graph", WS);
    const [paper] = await siblings(group, [
      { id: "paper", task: "Write paper.md.", body: () => checkSiblingWrite("generated/deck.html") },
      { id: "deck", task: "Build deck.html.", body: () => null },
    ]);
    expect(paper).toMatchObject({ owner: "node 'deck'" });
  });

  it("two different files in one directory both go through", async () => {
    const group = new SiblingWriteGroup("parallel_delegate", WS);
    const results = await siblings(group, [
      { id: "a", task: "Build site/a.html.", body: () => checkSiblingWrite("site/a.html") },
      { id: "b", task: "Build site/b.html.", body: () => checkSiblingWrite("site/b.html") },
    ]);
    expect(results).toEqual([null, null]);
  });

  /** A writes first and stays running until B has tried; returns [A's two tries, B's try]. */
  async function firstWriterThenSecond(group: SiblingWriteGroup, a: { id: string; task: string }, b: { id: string; task: string }, path: string) {
    let aWrote!: () => void;
    let bTried!: () => void;
    const wrote = new Promise<void>((resolve) => { aWrote = resolve; });
    const tried = new Promise<void>((resolve) => { bTried = resolve; });
    return siblings(group, [
      { ...a, body: async () => { const first = checkSiblingWrite(path); aWrote(); await tried; return [first, checkSiblingWrite(path)]; } },
      { ...b, body: async () => { await wrote; const result = checkSiblingWrite(path); bTried(); return result; } },
    ]);
  }

  it("a file no task names is the first running writer's", async () => {
    const [first, second] = await firstWriterThenSecond(
      new SiblingWriteGroup("parallel_delegate", WS),
      { id: "a", task: "Collect the data." },
      { id: "b", task: "Collect more data." },
      "data.json",
    );
    expect(first).toEqual([null, null]); // its own file, again and again
    expect(second).toMatchObject({ owner: "node 'a'" });
  });

  it("a file two running siblings both name goes to whichever writes it first", async () => {
    // A task that only refers to another's file (say, to cite it) must not take it over by naming it.
    const [builder, citer] = await firstWriterThenSecond(
      new SiblingWriteGroup("run_task_graph", WS),
      { id: "deck", task: "Build deck.html." },
      { id: "notes", task: "Write notes.md about the slides in deck.html." },
      "deck.html",
    );
    expect(builder).toEqual([null, null]);
    expect(citer).toMatchObject({ owner: "node 'deck'" });
  });

  it("an owner that finished owns nothing: a dependent writes after it", async () => {
    const group = new SiblingWriteGroup("run_task_graph", WS);
    await runAsWriteSibling(group, "deck", "node 'deck'", "Build deck.html.", async () => checkSiblingWrite("deck.html"));
    const review = await runAsWriteSibling(group, "review", "node 'review'", "Fix the typos.", async () => checkSiblingWrite("deck.html"));
    expect(review).toBeNull();
  });

  it("outside any fan-out every write goes through", () => {
    expect(checkSiblingWrite("deck.html")).toBeNull();
  });

  it("a sibling's nested delegation writes as that sibling, and a nested fan-out answers to both groups", async () => {
    const outer = new SiblingWriteGroup("run_task_graph", WS);
    const [coordinator] = await siblings(outer, [
      {
        id: "paper",
        task: "Write paper.md.",
        body: async () => {
          const inner = new SiblingWriteGroup("parallel_delegate", WS);
          return siblings(inner, [
            { id: "draft", task: "Draft section one.", body: () => [checkSiblingWrite("paper.md"), checkSiblingWrite("deck.html")] },
            { id: "figures", task: "Draw figures.png.", body: () => null },
          ]);
        },
      },
      { id: "deck", task: "Build deck.html.", body: () => null },
    ]) as Array<Array<Array<ReturnType<typeof checkSiblingWrite>>>>;
    const [draft] = coordinator!;
    expect(draft![0]).toBeNull(); // the outer member's own file
    expect(draft![1]).toMatchObject({ owner: "node 'deck'", kind: "run_task_graph" }); // the outer sibling's
  });

  it("a refusal claims nothing: once the named owner finished, the refused file is free again", async () => {
    const group = new SiblingWriteGroup("parallel_delegate", WS);
    let aTried!: () => void;
    let aMayFinish!: () => void;
    const tried = new Promise<void>((resolve) => { aTried = resolve; });
    const hold = new Promise<void>((resolve) => { aMayFinish = resolve; });
    const b = runAsWriteSibling(group, "b", "node 'b'", "Build x.html.", async () => { await tried; });
    const a = runAsWriteSibling(group, "a", "node 'a'", "Collect the data.", async () => {
      const result = checkSiblingWrite("x.html");
      aTried();
      await hold; // still running when c writes
      return result;
    });
    const c = runAsWriteSibling(group, "c", "node 'c'", "Collect more data.", async () => { await b; return checkSiblingWrite("x.html"); });
    const cResult = await c;
    aMayFinish();
    expect(await a).toMatchObject({ owner: "node 'b'" });
    expect(cResult).toBeNull(); // a's refused try did not make x.html a's
  });
});
