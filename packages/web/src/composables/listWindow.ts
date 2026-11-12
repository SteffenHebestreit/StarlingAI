/**
 * A long list, shown a page at a time.
 *
 * The management pages rendered every row they held, or stopped at a fixed number with no way to
 * the rest. A list window shows the first page of what the page's filter lets through, grows by
 * a page per "Show 50 more", and says how much of the list is on screen.
 *
 *   const rows = useListWindow(() => filteredJobs.value, { resetKey: () => `${status.value}|${search.value}` });
 *
 *   rows.visible     the rows to render
 *   rows.hasMore     whether a further step would add any
 *   rows.nextStep    how many the next step adds ("Show 50 more")
 *   rows.summary     "Showing 50 of 312"
 *   rows.showMore()
 *
 * The window goes back to one page when the filter changes — what comes back is another list.
 * A reload of the same list keeps it, so a refresh does not lose the reader's place.
 */
import { computed, ref, watch } from "vue";

export const LIST_PAGE_SIZE = 50;

export interface ListWindowCounts {
  /** Rows on screen. */
  shown: number;
  /** Rows the filter lets through. */
  total: number;
  hasMore: boolean;
  /** How many rows the next step adds; 0 when everything is on screen. */
  nextStep: number;
}

/** What a window of `limit` rows shows of a list of `total`. Never less than one page. */
export function windowCounts(total: number, limit: number, pageSize: number = LIST_PAGE_SIZE): ListWindowCounts {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const all = Math.max(0, Math.trunc(total) || 0);
  const shown = Math.min(all, Math.max(size, Math.trunc(limit) || 0));
  const rest = all - shown;
  return { shown, total: all, hasMore: rest > 0, nextStep: Math.min(size, rest) };
}

/** The count line: "Showing 50 of 312", or "Showing all 312" when nothing is held back. */
export function windowSummary(counts: Pick<ListWindowCounts, "shown" | "total">): string {
  if (counts.shown >= counts.total) return `Showing all ${counts.total}`;
  return `Showing ${counts.shown} of ${counts.total}`;
}

/**
 * What an empty list says when it is the filter that emptied it — a different thing from there
 * being nothing yet. `otherFilter`: a select beside the search box is set as well.
 */
export function noMatchLine(things: string, query: string, otherFilter = false): string {
  const text = query.trim();
  if (text && otherFilter) return `No ${things} match “${text}” with the current filter.`;
  if (text) return `No ${things} match “${text}”.`;
  return `No ${things} match the current filter.`;
}

/** The smallest whole number of pages that reaches the row at `index`. */
export function limitToReach(index: number, pageSize: number = LIST_PAGE_SIZE): number {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  return Math.max(1, Math.ceil((Math.trunc(index) + 1) / size)) * size;
}

export interface ListWindow<T> extends ListWindowCounts {
  /** The rows to render. */
  readonly visible: readonly T[];
  /** The list is longer than one page, so its count line is worth showing. */
  readonly paged: boolean;
  readonly summary: string;
  showMore(): void;
  /** Grow the window until the row at `index` is on screen (a selection made elsewhere). */
  reveal(index: number): void;
  /** Back to one page. */
  reset(): void;
}

export interface ListWindowOptions {
  pageSize?: number;
  /** Whatever the list is filtered by, as one value. A change puts the window back to one page. */
  resetKey?: () => unknown;
}

export function useListWindow<T>(items: () => readonly T[], options: ListWindowOptions = {}): ListWindow<T> {
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? LIST_PAGE_SIZE) || 1);
  const limit = ref(pageSize);
  const counts = computed(() => windowCounts(items().length, limit.value, pageSize));
  const visible = computed(() => items().slice(0, counts.value.shown));

  function reset(): void {
    limit.value = pageSize;
  }

  // Sync: the list under a new filter must never be drawn once with the old window.
  if (options.resetKey) watch(options.resetKey, reset, { flush: "sync" });

  // Getters, not refs: a ref inside a plain object is not unwrapped in a template, where
  // `rows.hasMore` would then always be true.
  return {
    get visible() { return visible.value; },
    get shown() { return counts.value.shown; },
    get total() { return counts.value.total; },
    get hasMore() { return counts.value.hasMore; },
    get nextStep() { return counts.value.nextStep; },
    get paged() { return counts.value.total > pageSize; },
    get summary() { return windowSummary(counts.value); },
    showMore() {
      // Only while rows are held back: a step pressed on a list that is all on screen must not
      // widen the window for a longer list that comes later.
      if (counts.value.hasMore) limit.value = counts.value.shown + pageSize;
    },
    reveal(index: number) {
      if (index < 0 || index >= counts.value.total) return;
      limit.value = Math.max(limit.value, limitToReach(index, pageSize));
    },
    reset,
  };
}
