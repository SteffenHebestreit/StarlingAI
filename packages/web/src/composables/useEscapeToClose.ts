/**
 * Escape closes the top-most open overlay — a lightbox, a preview, the side panel.
 *
 * `@keydown.esc.window` looks like it does this, but `.window` is not a Vue modifier: the
 * compiler treats it as a key name and binds the listener to the overlay element itself, which
 * never has focus, so Escape did nothing. A real listener on `window` does.
 *
 * Overlays stack. One Escape closes one of them — the one opened last — so pressing it over a
 * preview opened from the side panel closes the preview and leaves the panel. A key some other
 * handler already took (the composer's command popup calls preventDefault) is left alone, as is
 * one pressed mid-composition.
 */
import { onScopeDispose, watch } from "vue";

interface Layer {
  close: () => void;
}

const openLayers: Layer[] = [];
let listening = false;

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  const top = openLayers[openLayers.length - 1];
  if (!top) return;
  event.preventDefault();
  top.close();
}

function sync(): void {
  if (typeof window === "undefined") return;
  if (openLayers.length > 0 && !listening) {
    window.addEventListener("keydown", onKeydown);
    listening = true;
  } else if (openLayers.length === 0 && listening) {
    window.removeEventListener("keydown", onKeydown);
    listening = false;
  }
}

function remove(layer: Layer): void {
  const index = openLayers.indexOf(layer);
  if (index >= 0) openLayers.splice(index, 1);
  sync();
}

/** While `isOpen()` is true, Escape calls `close` — unless an overlay opened after this one is still open. */
export function useEscapeToClose(isOpen: () => boolean, close: () => void): void {
  const layer: Layer = { close };
  watch(isOpen, (open) => {
    remove(layer);
    if (open) {
      openLayers.push(layer);
      sync();
    }
  }, { immediate: true });
  onScopeDispose(() => remove(layer));
}
