/**
 * One way to ask "are you sure?" across the dashboard.
 *
 * Actions that cannot be taken back (delete a session, reset one, cut a conversation back to an
 * earlier message) ran on a single click in some places and behind the browser's own `confirm()`
 * box in others — a grey system dialog in the middle of the HUD, which also blocks the page's
 * rendering while it is up. `confirmAction()` asks in the dashboard's own dialog
 * (components/ConfirmHost.vue, mounted once in App.vue) and resolves to the answer.
 *
 * Only one question is on screen at a time: asking a second one answers the first with "no".
 */
import { readonly, shallowRef } from "vue";

export interface ConfirmRequest {
  /** What is about to happen, as a short question or statement: "Delete this session?" */
  title: string;
  /** What that means for the user: what is lost, and whether it can be undone. */
  message?: string;
  /** The button that goes ahead; names the action ("Delete"), never just "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** The action destroys something or lowers a protection: the go-ahead button is styled as a warning. */
  danger?: boolean;
  /**
   * The small line above the title. Defaults to "Cannot be undone" for a dangerous action — say
   * what it is instead where that is not true (a protection that can be switched back on).
   */
  eyebrow?: string;
}

interface PendingConfirm extends ConfirmRequest {
  answer: (confirmed: boolean) => void;
}

const pending = shallowRef<PendingConfirm | null>(null);

/** The question on screen, for the host component. */
export const pendingConfirm = readonly(pending);

/** Ask, and get the answer: true only for the go-ahead button. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  pending.value?.answer(false);
  return new Promise<boolean>((resolve) => {
    const entry: PendingConfirm = {
      ...request,
      answer: (confirmed) => {
        if (pending.value === entry) pending.value = null;
        resolve(confirmed);
      },
    };
    pending.value = entry;
  });
}

/** The host's buttons, Escape and a click beside the dialog all end here. */
export function answerConfirm(confirmed: boolean): void {
  pending.value?.answer(confirmed);
}
