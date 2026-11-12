/**
 * The time zone this browser runs in, as chat.send carries it (`timeZone`): the gateway runs in UTC,
 * and "remind me tomorrow at nine" is nine on the person's own clock. Nothing when the browser
 * cannot say.
 */
export function browserTimeZone(): { timeZone?: string } {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === "string" && timeZone ? { timeZone } : {};
  } catch {
    return {};
  }
}
