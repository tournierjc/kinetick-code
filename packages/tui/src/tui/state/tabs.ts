/**
 * Open Session tabs.
 *
 * The tab list is deliberately thin: it holds only the ordered set of Sessions
 * the shell keeps open. Visibility stays in `TuiState.activeSessionId`, so a
 * tab never carries a second copy of it and the two can never disagree.
 *
 * Ordering rules that the shell depends on:
 * - The active Session is always an open tab. `session/activate` appends it, so
 *   every existing navigation path (`/sessions`, `/new`, `/continue`, resume)
 *   creates tabs without touching each call site.
 * - Closing never rearranges the remaining tabs, so a tab keeps its key binding
 *   and its position on the bar while other Sessions open and close.
 */

export interface TuiTabListState {
  readonly order: readonly string[];
}

export const EMPTY_TUI_TAB_LIST: TuiTabListState = { order: [] };

/**
 * Number of tabs reachable through a direct `Alt+<n>` binding. The bar may show
 * more tabs than this; cycling covers all of them.
 */
export const TUI_TAB_DIRECT_SLOT_COUNT = 9;

export function openTuiTab(order: readonly string[], sessionId: string): readonly string[] {
  return order.includes(sessionId) ? order : [...order, sessionId];
}

export function closeTuiTab(order: readonly string[], sessionId: string): readonly string[] {
  return order.includes(sessionId) ? order.filter((id) => id !== sessionId) : order;
}

/**
 * Session that should become visible when `closingId` is closed: the next tab to
 * the right, else the previous one. `undefined` means the closed tab was the
 * last one, and the caller decides what to show instead (a new Session).
 *
 * The caller must activate the neighbour *before* dispatching the close: the
 * reducer refuses to close the visible tab, so the invariant that the active
 * Session is always an open tab holds at every step.
 */
export function selectTuiTabAfterClose(
  order: readonly string[],
  closingId: string,
): string | undefined {
  const index = order.indexOf(closingId);
  if (index < 0) return undefined;
  return order[index + 1] ?? order[index - 1];
}

/** Session bound to the 1-based direct slot `slot`, when that tab exists. */
export function selectTuiTabSlot(order: readonly string[], slot: number): string | undefined {
  if (!Number.isInteger(slot) || slot < 1 || slot > TUI_TAB_DIRECT_SLOT_COUNT) return undefined;
  return order[slot - 1];
}

/**
 * Next or previous tab relative to `activeId`. Wraps, so cycling from the last
 * tab reaches the first. A Session that is not on the bar yet starts the cycle
 * at its first tab, which keeps the binding useful before any switch happened.
 */
export function cycleTuiTab(
  order: readonly string[],
  activeId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (order.length === 0) return undefined;
  const index = activeId ? order.indexOf(activeId) : -1;
  if (index < 0) return delta > 0 ? order[0] : order[order.length - 1];
  return order[(index + delta + order.length) % order.length];
}
