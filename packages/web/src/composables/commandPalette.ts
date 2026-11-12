/**
 * The command palette's list: what it offers and how a query narrows it.
 *
 * The dashboard has some twenty pages behind a burger and two levels of menu. The palette
 * (components/CommandPalette.vue, Ctrl/Cmd+K) reaches any of them, and a few actions, by typing a
 * few letters. This is its logic, free of Vue so it can be exercised on its own.
 */

export interface PaletteCommand {
  /** Stable key for the list. */
  id: string;
  /** What the row says: "Sessions", "New session". */
  label: string;
  /** The menu group it lives in ("Logs"), or what kind of command it is ("Action"). */
  group: string;
  /** A second line: what the page is for. */
  hint?: string;
  /** Other words a user may type for it. */
  keywords?: string;
  /** The page to open … */
  to?: string;
  /** … or the thing to do. */
  run?: () => void;
}

const normalise = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * How well a command answers a query: 0 for no match, higher for a better one. Every word of the
 * query has to be found somewhere in the command; a label that starts with the query beats one
 * that only contains it, which beats a match in the group, the hint or the keywords.
 */
export function scoreCommand(command: PaletteCommand, query: string): number {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const label = normalise(command.label);
  const rest = normalise(`${command.group} ${command.hint ?? ""} ${command.keywords ?? ""}`);
  let score = 0;
  for (const word of words) {
    if (label.startsWith(word)) score += 8;
    else if (label.split(/\s+/).some((part) => part.startsWith(word))) score += 6;
    else if (label.includes(word)) score += 4;
    else if (rest.includes(word)) score += 1;
    else return 0;
  }
  return score;
}

/** The commands a query leaves, best first; ties keep the list's own order (the menu's). */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  return commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** The row to highlight after an arrow key: wraps round both ends, 0 for an empty list. */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/** Whether a key event is the palette's shortcut: Ctrl+K, or Cmd+K on a Mac — and nothing else held. */
export function isPaletteShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}
