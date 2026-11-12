import { describe, expect, it } from "vitest";
import { filterCommands, isPaletteShortcut, moveSelection, scoreCommand, type PaletteCommand } from "./commandPalette";

const commands: PaletteCommand[] = [
  { id: "chat", label: "Chat", group: "Go to", to: "/" },
  { id: "jobs", label: "Jobs", group: "Live", hint: "Scenes & runs", to: "/jobs" },
  { id: "sessions", label: "Sessions", group: "Logs", hint: "Chat history", to: "/sessions" },
  { id: "audit", label: "Audit", group: "Logs", hint: "Event log", to: "/audit" },
  { id: "tuning", label: "Agent tuning", group: "Manage", hint: "Models & routing", to: "/agents" },
  { id: "catalog", label: "Agent catalog", group: "Go to", to: "/catalog" },
  { id: "settings", label: "Settings", group: "Manage", hint: "Providers & config", keywords: "theme appearance palette", to: "/settings" },
  { id: "new", label: "New session", group: "Action" },
];
const ids = (query: string) => filterCommands(commands, query).map((command) => command.id);

describe("the command palette's filter", () => {
  it("offers everything, in the menu's order, before anything is typed", () => {
    expect(ids("")).toEqual(commands.map((command) => command.id));
    expect(ids("   ")).toEqual(commands.map((command) => command.id));
  });

  it("puts a label that starts with the query before one that only contains it", () => {
    // "se" starts "Sessions" and "Settings"; "New session" has a word that starts with it.
    expect(ids("se")).toEqual(["sessions", "settings", "new"]);
  });

  it("finds a page by its group, its hint or its other words", () => {
    expect(ids("logs")).toEqual(["sessions", "audit"]);
    expect(ids("routing")).toEqual(["tuning"]);
    expect(ids("theme")).toEqual(["settings"]);
  });

  it("needs every word of the query", () => {
    expect(ids("agent tun")).toEqual(["tuning"]);
    expect(ids("agent xyz")).toEqual([]);
  });

  it("does not care about case or accents", () => {
    expect(ids("SESS")).toEqual(["sessions", "new"]);
    expect(scoreCommand({ id: "x", label: "Übersicht", group: "Go to" }, "uber")).toBeGreaterThan(0);
  });

  it("ranks a label match above a match in the small print", () => {
    // "chat" is the Chat page's label and only the Sessions page's hint.
    expect(ids("chat")).toEqual(["chat", "sessions"]);
  });
});

describe("moving through the list", () => {
  it("wraps round both ends", () => {
    expect(moveSelection(0, -1, 5)).toBe(4);
    expect(moveSelection(4, 1, 5)).toBe(0);
    expect(moveSelection(2, 1, 5)).toBe(3);
  });

  it("stays put on an empty list", () => {
    expect(moveSelection(3, 1, 0)).toBe(0);
  });
});

describe("the shortcut", () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

  it("is Ctrl+K or Cmd+K", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true, key: "K" }))).toBe(true);
  });

  it("is not a bare k, nor K with other keys held", () => {
    expect(isPaletteShortcut(key({}))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: "j" }))).toBe(false);
  });
});
