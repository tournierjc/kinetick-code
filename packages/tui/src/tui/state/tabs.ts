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
 * - Opening appends, and only an explicit move (`/tabs move`, `Shift+Alt+←/→`)
 *   rearranges the bar. Slots are positional, so nothing may reorder behind the
 *   user's back: an ordering the user set survives every other tab action.
 */

export interface TuiTabListState {
  readonly order: readonly string[];
  /**
   * Group the bar by project. Grouping only draws when the open tabs span more
   * than one project, so a single-project bar is unaffected either way.
   */
  readonly grouped: boolean;
  /**
   * Groups the user folded away. A group holding the visible Session is never
   * treated as collapsed, so the visible tab can never be hidden — the same rule
   * that keeps the visible tab from being closed.
   */
  readonly collapsedGroups: readonly string[];
}

export const EMPTY_TUI_TAB_LIST: TuiTabListState = {
  order: [],
  grouped: true,
  collapsedGroups: [],
};

/**
 * Number of tabs reachable through a direct `Alt+<n>` binding. The bar may show
 * more tabs than this; cycling covers all of them.
 */
export const TUI_TAB_DIRECT_SLOT_COUNT = 9;

export function openTuiTab(order: readonly string[], sessionId: string): readonly string[] {
  return order.includes(sessionId) ? order : [...order, sessionId];
}

/**
 * Swap the Session a tab shows, leaving the tab where it is.
 *
 * `/clear` starts a fresh conversation in the tab that is already there rather
 * than opening another one, so the bar keeps its length and the new Session takes
 * the replaced tab's position — and with it its direct `Alt+<n>` slot. A Session
 * is one tab: a replacement that is somehow already open loses its other slot.
 *
 * Returns the same list when there is nothing to replace, so the reducer can skip
 * a state update — the same contract `openTuiTab` and `closeTuiTab` follow.
 */
export function replaceTuiTab(
  order: readonly string[],
  sessionId: string,
  replacementId: string,
): readonly string[] {
  if (sessionId === replacementId) return order;
  const index = order.indexOf(sessionId);
  if (index < 0) return order;
  const withoutReplacement = order.filter((id) => id !== replacementId);
  const target = withoutReplacement.indexOf(sessionId);
  if (target < 0) return order;
  return [
    ...withoutReplacement.slice(0, target),
    replacementId,
    ...withoutReplacement.slice(target + 1),
  ];
}

/**
 * Move one tab by `delta` positions, leaving every other tab where it is.
 *
 * The bar's direct slots are positional (`Alt+<n>`), so moving a tab is how a
 * Session is put on the key the user expects. A move past either end is clamped,
 * not wrapped: sending the first tab earlier does nothing rather than teleporting
 * it to the far end.
 *
 * Returns the same list when nothing would change, so the reducer can skip a
 * state update — the same contract `openTuiTab` and `closeTuiTab` follow.
 */
export function moveTuiTab(
  order: readonly string[],
  sessionId: string,
  delta: number,
): readonly string[] {
  const index = order.indexOf(sessionId);
  const step = Math.trunc(delta);
  if (index < 0 || step === 0) return order;
  const target = index + step;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  next.splice(index, 1);
  next.splice(target, 0, sessionId);
  return next;
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

/** Turn project grouping on or off without touching the open tabs. */
export function setTuiTabGrouping(
  state: TuiTabListState,
  grouped: boolean,
): TuiTabListState {
  return state.grouped === grouped ? state : { ...state, grouped };
}

/**
 * Fold a group away, or unfold it again. Folding the visible Session's group is
 * recorded here and ignored when rendering, so unfolding later restores it.
 */
export function toggleTuiTabGroupCollapsed(
  state: TuiTabListState,
  groupKey: string,
): TuiTabListState {
  const collapsedGroups = state.collapsedGroups.includes(groupKey)
    ? state.collapsedGroups.filter((key) => key !== groupKey)
    : [...state.collapsedGroups, groupKey];
  return { ...state, collapsedGroups };
}

/**
 * Collapsed keys after the fold key is pressed: every group *but* the one holding
 * the visible tab, or none at all when they are already folded. Folding the group
 * on screen would hide the Session the user is looking at, so the key folds
 * around it instead.
 *
 * Returns `collapsedGroups` unchanged when there is nothing to fold (no visible
 * tab, or a single group): callers compare by identity to tell "no change" from
 * "unfold everything".
 */
export function foldingTuiTabGroups(
  groupKeys: readonly string[],
  activeGroupKey: string | undefined,
  collapsedGroups: readonly string[],
): readonly string[] {
  if (activeGroupKey === undefined) return collapsedGroups;
  const others = groupKeys.filter((key) => key !== activeGroupKey);
  if (others.length === 0) return collapsedGroups;
  return others.every((key) => collapsedGroups.includes(key)) ? [] : others;
}

/**
 * Collapsed keys that actually hide tabs. The group holding the visible Session
 * always stays open, so the bar can never hide the Session on screen.
 *
 * Folding is a rendering choice only: cycling and the direct slots still reach
 * every open tab, so a folded group is never a keyboard dead end.
 */
export function applyingTuiTabGroupCollapse(
  collapsedGroups: readonly string[],
  activeGroupKey: string | undefined,
): readonly string[] {
  if (activeGroupKey === undefined) return collapsedGroups;
  return collapsedGroups.filter((key) => key !== activeGroupKey);
}
