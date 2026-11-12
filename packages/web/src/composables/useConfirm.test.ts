import { afterEach, describe, expect, it } from "vitest";
import { answerConfirm, confirmAction, pendingConfirm } from "./useConfirm";

afterEach(() => answerConfirm(false));

describe("confirmAction", () => {
  it("puts the question on screen and resolves to the go-ahead", async () => {
    const asked = confirmAction({ title: "Delete this session?", confirmLabel: "Delete", danger: true });
    expect(pendingConfirm.value).toMatchObject({ title: "Delete this session?", confirmLabel: "Delete", danger: true });
    answerConfirm(true);
    await expect(asked).resolves.toBe(true);
    expect(pendingConfirm.value).toBeNull();
  });

  it("resolves to no when the user backs out", async () => {
    const asked = confirmAction({ title: "Reset?", confirmLabel: "Reset" });
    answerConfirm(false);
    await expect(asked).resolves.toBe(false);
    expect(pendingConfirm.value).toBeNull();
  });

  it("answers a question that is still open with no when another one is asked", async () => {
    const first = confirmAction({ title: "First?", confirmLabel: "Yes" });
    const second = confirmAction({ title: "Second?", confirmLabel: "Yes" });
    await expect(first).resolves.toBe(false);
    // The second question is the one on screen, and the first one's late answer cannot close it.
    expect(pendingConfirm.value?.title).toBe("Second?");
    answerConfirm(true);
    await expect(second).resolves.toBe(true);
  });

  it("does nothing when an answer comes with no question open", () => {
    expect(() => answerConfirm(true)).not.toThrow();
    expect(pendingConfirm.value).toBeNull();
  });
});
