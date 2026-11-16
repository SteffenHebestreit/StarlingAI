import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useNotificationStore } from "./notifications";

beforeEach(() => setActivePinia(createPinia()));

describe("notification actions", () => {
  it("keeps a toast's own button with it", () => {
    const store = useNotificationStore();
    const run = vi.fn();
    store.pushLocalNotification({ id: "update", title: "New version", message: "Reload to use it.", sticky: true, action: { label: "Reload", run } });
    expect(store.items[0]?.action?.label).toBe("Reload");
    store.items[0]?.action?.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("has no button unless one is given, or when it has no label", () => {
    const store = useNotificationStore();
    store.pushLocalNotification({ id: "plain", title: "Saved", message: "Done.", sticky: true });
    store.pushLocalNotification({ id: "blank", title: "Saved", message: "Done.", sticky: true, action: { label: "  ", run: () => {} } });
    expect(store.items.map((item) => item.action)).toEqual([undefined, undefined]);
  });
});
