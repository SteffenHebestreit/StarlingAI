/**
 * Tab stays inside a dialog while it is open.
 *
 * A modal dialog covers the page, but the page's links and fields were still in the tab order:
 * Tab from the dialog's last button walked on into what lies behind it, out of sight. While a
 * trap is active for a dialog's element, Tab and Shift+Tab go round inside it, and a focus that
 * ended up outside anyway (a click on the backdrop, a frame handing it on) comes back on the
 * next Tab.
 *
 * It answers Tab and nothing else: where the focus starts and where it goes back to stays the
 * dialog's own business. Traps stack like the overlays of useEscapeToClose — the dialog opened
 * last has the keyboard, so a question asked over a form keeps Tab in the question. A Tab some
 * other handler already took (the command palette, the composer's command popup) is left alone.
 */
import { onScopeDispose, toValue, watch, type MaybeRefOrGetter } from "vue";

/**
 * Where Tab goes from `active`, given the dialog's tab stops in document order — or null to let
 * the browser take the step itself, which between two stops it does best (a radio group, a frame).
 *
 * Only the ends are turned round: after the last stop comes the first, before the first the last.
 * An `active` that is no stop starts at an end, with one exception: inside the dialog (its own
 * frame, a spot a click chose) the browser steps on from there for as long as a stop lies that
 * way. `liesBefore` says so for such an `active`: whether it comes before a stop in the document.
 */
export function focusTrapTarget<T>(
  stops: readonly T[],
  active: T | null | undefined,
  backwards: boolean,
  liesBefore?: (stop: T) => boolean,
): T | null {
  if (stops.length === 0) return null;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const at = active == null ? -1 : stops.indexOf(active);
  if (at >= 0) {
    if (backwards) return at === 0 ? last : null;
    return at === stops.length - 1 ? first : null;
  }
  if (liesBefore) {
    const stopThatWay = backwards ? stops.some((stop) => !liesBefore(stop)) : stops.some(liesBefore);
    if (stopThatWay) return null;
  }
  return backwards ? last : first;
}

// Everything Tab can stop at by itself, and anything given a tabindex. Wider rather than
// narrower: a stop missing from this list at the end of a dialog could never be reached.
const CANDIDATES = [
  "a[href]", "area[href]", "button", "input:not([type='hidden'])", "select", "textarea",
  "iframe", "object", "embed", "summary", "audio[controls]", "video[controls]",
  "[contenteditable]:not([contenteditable='false'])", "[tabindex]",
].join(",");

function isShown(el: HTMLElement): boolean {
  // No box at all: display none, here or on something around it.
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/** A radio group is one stop — its checked button. The others are skipped while one is checked. */
function isPassedOverRadio(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.checked || !el.name) return false;
  const group = (el.form ?? el.ownerDocument).querySelectorAll<HTMLInputElement>("input[type='radio']");
  return [...group].some((other) => other.name === el.name && other.form === el.form && other.checked);
}

/** The elements Tab stops at inside `container`, in document order, as they are right now. */
export function tabStops(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(CANDIDATES)].filter((el) => {
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
    return !el.matches(":disabled") && el.closest("[inert]") === null && isShown(el) && !isPassedOverRadio(el);
  });
}

interface Trap {
  element: HTMLElement | null;
}

/** The active traps, in the order they became active: the last one has the keyboard. */
const traps: Trap[] = [];
let listening = false;

function topContainer(): HTMLElement | null {
  for (let index = traps.length - 1; index >= 0; index -= 1) {
    const element = traps[index]!.element;
    if (element?.isConnected) return element;
  }
  return null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.isComposing) return;
  // Ctrl+Tab and Alt+Tab belong to the browser and the system.
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const container = topContainer();
  if (!container) return;

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inside = active !== null && container.contains(active);
  // A dialog without a trap may be open above this one — the live browser, where a key belongs
  // to the page being driven. Focus in there is not ours to move.
  if (active && !inside && active.closest("[aria-modal='true']") && !traps.some((trap) => trap.element?.contains(active))) return;

  const stops = tabStops(container);
  if (stops.length === 0) {
    // Nothing to stop at: Tab stays where it is rather than leave.
    event.preventDefault();
    return;
  }
  const target = focusTrapTarget(
    stops,
    inside ? active : null,
    event.shiftKey,
    inside ? (stop) => Boolean(active.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined,
  );
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function sync(): void {
  if (typeof window === "undefined") return;
  if (traps.length > 0 && !listening) {
    window.addEventListener("keydown", onKeydown);
    listening = true;
  } else if (traps.length === 0 && listening) {
    window.removeEventListener("keydown", onKeydown);
    listening = false;
  }
}

function release(trap: Trap): void {
  trap.element = null;
  const index = traps.indexOf(trap);
  if (index >= 0) traps.splice(index, 1);
  sync();
}

/**
 * Keeps Tab inside `container` for as long as it names an element: pass the dialog's template
 * ref, or a getter that is null while the dialog is closed. Does not move the focus by itself.
 */
export function useFocusTrap(container: MaybeRefOrGetter<HTMLElement | null | undefined>): void {
  const trap: Trap = { element: null };
  watch(() => toValue(container) ?? null, (element) => {
    if (!element) {
      release(trap);
      return;
    }
    trap.element = element;
    // A dialog whose element was only swapped keeps its place under whatever opened after it.
    if (!traps.includes(trap)) traps.push(trap);
    sync();
  }, { immediate: true, flush: "post" });
  onScopeDispose(() => release(trap));
}
