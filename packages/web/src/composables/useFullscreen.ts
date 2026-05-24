import { onUnmounted, ref, type Ref } from "vue";

/**
 * Fullscreen toggle for a target element (live session viewers).
 *
 * Shared by ComputerSessionPanel and BrowserSessionPanel so the operator can
 * blow the live preview up to the whole screen — useful when interacting with a
 * remote desktop or solving a CAPTCHA in the browser handoff. Uses the standard
 * Fullscreen API with a webkit fallback (Safari).
 */
export function useFullscreen(target: Ref<HTMLElement | null>) {
  const isFullscreen = ref(false);

  function sync() {
    const fsEl = document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ?? null;
    isFullscreen.value = !!fsEl && (!target.value || fsEl === target.value);
  }

  async function enter(): Promise<void> {
    const el = target.value as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (!el) return;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    } catch {
      // user gesture / permission errors are non-fatal — leave state as-is
    }
  }

  async function exit(): Promise<void> {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    } catch {
      // ignore
    }
  }

  async function toggle(): Promise<void> {
    if (isFullscreen.value) await exit();
    else await enter();
  }

  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync as EventListener);
  onUnmounted(() => {
    document.removeEventListener("fullscreenchange", sync);
    document.removeEventListener("webkitfullscreenchange", sync as EventListener);
  });

  return { isFullscreen, toggle, enter, exit };
}
