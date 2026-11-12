/**
 * A word of confirmation, or of failure, after something the user did.
 *
 * Most pages said nothing after a save or a delete: the form just sat there, and a failure showed
 * at best in a line somewhere on the page — which the refresh that follows a mutation then wiped.
 * The shell already shows toasts (App.vue, from stores/notifications.ts); this is the two-line way
 * to raise one from a page.
 *
 *   const toast = useToast();
 *   toast.success("Skill saved", "\"Weekly report\" is active.");
 *   toast.error("Couldn't delete the peer", errorText(err));
 */
import { useNotificationStore } from "@/stores/notifications";

/** What went wrong, as text for a person: an Error's message, or the thing itself. */
export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === "string" ? error : String(error ?? "");
  return text.trim() || "Unknown error";
}

export interface Toast {
  /** It worked: what was done, and to what. */
  success(title: string, message: string): void;
  /** It did not: what was attempted, and why it failed. Stays until dismissed. */
  error(title: string, message: string): void;
  /** Worth knowing, neither a success nor a failure. */
  info(title: string, message: string): void;
}

export function useToast(): Toast {
  const notifications = useNotificationStore();
  return {
    success: (title, message) => notifications.pushLocalNotification({ title, message, level: "success" }),
    // A failure does not time out with the successes: the user may be looking elsewhere when it lands.
    error: (title, message) => notifications.pushLocalNotification({ title, message, level: "error", sticky: true }),
    info: (title, message) => notifications.pushLocalNotification({ title, message, level: "info" }),
  };
}
