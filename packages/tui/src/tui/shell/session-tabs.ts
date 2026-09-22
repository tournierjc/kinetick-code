/**
 * Session tab bar.
 *
 * A chrome row listing the open Session tabs with their live state: which one is
 * visible, which one is working, which one is waiting for an answer, and which
 * ones finished a turn while another tab was on screen.
 *
 * With grouping off — or when every open tab belongs to the same project — the
 * bar is a single strip that never wraps: rows inside the conversation area are
 * part of the document frame, so a second row would move the transcript. When
 * the tabs do not fit, the trailing ones are replaced by a `+N` counter; the
 * visible tab is never the one that gets dropped.
 *
 * When the open tabs span several projects the bar groups them: one header row
 * per project, then one row of tabs per expanded project, capped by
 * `maximumRows`. The group holding the visible tab is never dropped, and tabs
 * dropped or folded are still reachable by cycling and by the direct slots.
 *
 * The resolvers are separated from the component so grouping, tab selection and
 * fitting can be tested without a terminal.
 */

import type { Component } from '../rendering/component.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { TUI_TAB_DIRECT_SLOT_COUNT, applyingTuiTabGroupCollapse } from '../state/tabs.js';

export interface TuiSessionTabStatus {
  /** A turn is in flight for this Session. */
  readonly running: boolean;
  /** Permission or questionnaire pending: the tab needs an answer to continue. */
  readonly blocked: boolean;
  /** Turns that settled while another tab was visible. */
  readonly unread: number;
}

export const IDLE_TUI_SESSION_TAB_STATUS: TuiSessionTabStatus = {
  running: false,
  blocked: false,
  unread: 0,
};

/** Row cap for the grouped bar; the group holding the visible tab is kept. */
export const TUI_TAB_MAXIMUM_GROUP_ROWS = 5;

/** Group key of a Session that has no workspace, i.e. no project to group under. */
export const TUI_TAB_UNGROUPED_KEY = '';

const TUI_TAB_UNGROUPED_LABEL = 'No project';

export interface TuiSessionTabCatalogEntry {
  readonly sessionId: string;
  readonly title?: string;
}

/** Project a Session belongs to, as the bar shows it. */
export interface TuiSessionTabGroupRef {
  /** Stable key: the workspace directory. */
  readonly key: string;
  /** Short label for the header: the workspace folder name. */
  readonly label: string;
}

/** Minimal Session shape needed to place a tab in its project. */
export interface TuiSessionTabGroupSource {
  readonly sessionId: string;
  readonly workspaceDir?: string;
}

/**
 * Project of each Session, keyed by Session id. Grouping uses the workspace, so
 * two Sessions started in the same directory share a group and a Session without
 * a workspace (a side conversation, say) lands under `No project`.
 */
export function resolveTuiSessionTabGroupRefs(
  sessions: readonly TuiSessionTabGroupSource[],
): ReadonlyMap<string, TuiSessionTabGroupRef> {
  const refs = new Map<string, TuiSessionTabGroupRef>();
  for (const session of sessions) {
    refs.set(session.sessionId, resolveTuiSessionTabGroupRef(session.workspaceDir));
  }
  return refs;
}

/** Project of one workspace directory. */
export function resolveTuiSessionTabGroupRef(
  workspaceDir: string | undefined,
): TuiSessionTabGroupRef {
  const normalized = workspaceDir?.trim().replace(/[/\\]+$/, '') ?? '';
  if (!normalized) return { key: TUI_TAB_UNGROUPED_KEY, label: TUI_TAB_UNGROUPED_LABEL };
  const segments = normalized.split(/[/\\]/).filter((segment) => segment.length > 0);
  return { key: normalized, label: segments[segments.length - 1] ?? normalized };
}

/** Shape of the per-Session Runtime view the status is derived from. */
export interface TuiSessionTabViewSource {
  readonly execution: {
    readonly runs: ReadonlyMap<string, { readonly status: string }>;
  };
  readonly attention: {
    readonly permission: boolean;
    readonly question: boolean;
    readonly unread: number;
  };
}

export interface ResolveTuiSessionTabsInput {
  readonly order: readonly string[];
  readonly activeSessionId?: string;
  readonly catalog: readonly TuiSessionTabCatalogEntry[];
  readonly statusOf: (sessionId: string) => TuiSessionTabStatus | undefined;
}

export interface TuiSessionTabView {
  readonly sessionId: string;
  /** 1-based direct binding slot, absent for tabs past the direct slots. */
  readonly slot?: number;
  readonly label: string;
  readonly active: boolean;
  readonly status: TuiSessionTabStatus;
  /** The Session is gone from the catalog: the tab can only be closed. */
  readonly unavailable: boolean;
}

/** One project's worth of tabs, in bar order. */
export interface TuiSessionTabGroup {
  readonly key: string;
  readonly label: string;
  readonly collapsed: boolean;
  readonly tabs: readonly TuiSessionTabView[];
  /** Combined status of the tabs, so a folded group still shows activity. */
  readonly status: TuiSessionTabStatus;
}

export interface ResolveTuiSessionTabGroupsInput {
  readonly tabs: readonly TuiSessionTabView[];
  /** Project of a Session; tabs without one join the `No project` group. */
  readonly groupOf: (sessionId: string) => TuiSessionTabGroupRef | undefined;
  /** Folded groups, already filtered of the visible Session's group. */
  readonly collapsedGroups: readonly string[];
}

/**
 * Group tabs by project. Returns `undefined` when the tabs span a single
 * project: there is nothing to tell apart, and the bar stays one strip.
 */
export function resolveTuiSessionTabGroups(
  input: ResolveTuiSessionTabGroupsInput,
): readonly TuiSessionTabGroup[] | undefined {
  const active = input.tabs.find((tab) => tab.active);
  // Folding the group that holds the visible tab is recorded in state and
  // ignored here, so the bar can never hide the Session on screen.
  const collapsedKeys = applyingTuiTabGroupCollapse(
    input.collapsedGroups,
    active ? (input.groupOf(active.sessionId) ?? resolveTuiSessionTabGroupRef(undefined)).key : undefined,
  );
  const grouped = new Map<string, { ref: TuiSessionTabGroupRef; tabs: TuiSessionTabView[] }>();
  for (const tab of input.tabs) {
    const ref = input.groupOf(tab.sessionId) ?? resolveTuiSessionTabGroupRef(undefined);
    const entry = grouped.get(ref.key);
    if (entry) entry.tabs.push(tab);
    else grouped.set(ref.key, { ref, tabs: [tab] });
  }
  if (grouped.size < 2) return undefined;
  return [...grouped.values()].map(({ ref, tabs }) => ({
    key: ref.key,
    label: sanitizeTerminalText(ref.label),
    collapsed: collapsedKeys.includes(ref.key),
    tabs,
    status: combineTuiSessionTabStatus(tabs),
  }));
}

/** Combined status of several tabs: any activity wins, unread counts add up. */
export function combineTuiSessionTabStatus(
  tabs: readonly TuiSessionTabView[],
): TuiSessionTabStatus {
  let unread = 0;
  let running = false;
  let blocked = false;
  for (const tab of tabs) {
    unread += tab.status.unread;
    running = running || tab.status.running;
    blocked = blocked || tab.status.blocked;
  }
  return { running, blocked, unread };
}

/** Derive the bar status from a Runtime Session view. */
export function resolveTuiSessionTabStatus(
  view: TuiSessionTabViewSource | undefined,
): TuiSessionTabStatus {
  if (!view) return IDLE_TUI_SESSION_TAB_STATUS;
  let running = false;
  for (const run of view.execution.runs.values()) {
    if (run.status === 'running' || run.status === 'starting' || run.status === 'blocked') {
      running = true;
      break;
    }
  }
  return {
    running,
    blocked: view.attention.permission || view.attention.question,
    unread: view.attention.unread,
  };
}

export function resolveTuiSessionTabs(
  input: ResolveTuiSessionTabsInput,
): readonly TuiSessionTabView[] {
  const titles = new Map(input.catalog.map((session) => [session.sessionId, session.title]));
  return input.order.map((sessionId, index) => {
    const title = titles.get(sessionId)?.trim();
    return {
      sessionId,
      ...(index < TUI_TAB_DIRECT_SLOT_COUNT ? { slot: index + 1 } : {}),
      label: sanitizeTerminalText(title || 'Untitled session'),
      active: sessionId === input.activeSessionId,
      status: input.statusOf(sessionId) ?? IDLE_TUI_SESSION_TAB_STATUS,
      unavailable: !titles.has(sessionId),
    };
  });
}

export interface TuiSessionTabsModel {
  readonly tabs: readonly TuiSessionTabView[];
  /** Absent when the tabs belong to one project: the bar is a single strip. */
  readonly groups?: readonly TuiSessionTabGroup[];
}

export interface TuiSessionTabsOptions {
  /** Read on every render: the bar reflects the current state without a subscription. */
  readonly tabs: () => TuiSessionTabsModel;
  /** Fewer open tabs than this render no bar at all. */
  readonly minimumTabs?: number;
  /** Row cap for the grouped bar, default `TUI_TAB_MAXIMUM_GROUP_ROWS`. */
  readonly maximumRows?: number;
}

export class TuiSessionTabs implements Component {
  constructor(private readonly options: TuiSessionTabsOptions) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const model = this.options.tabs();
    const { tabs, groups } = model;
    if (tabs.length < (this.options.minimumTabs ?? 2)) return [];
    if (!groups || groups.length < 2) return renderStrip(tabs, width);
    const budget = Math.max(1, this.options.maximumRows ?? TUI_TAB_MAXIMUM_GROUP_ROWS);
    const kept = fitGroups(groups, budget);
    const hiddenTabs = groups.reduce(
      (total, group, index) => (kept[index] ? total : total + group.tabs.length),
      0,
    );
    const rows: string[] = [];
    groups.forEach((group, index) => {
      if (!kept[index]) return;
      rows.push(renderGroupHeader(group, width));
      if (!group.collapsed) rows.push(...renderStrip(group.tabs, width));
    });
    if (hiddenTabs > 0 && rows.length > 0) {
      rows[rows.length - 1] = appendCounter(rows[rows.length - 1] as string, hiddenTabs, width);
    }
    return rows;
  }

  invalidate(): void {}
}

/** One strip row for a set of tabs, with the visible tab kept and fitted. */
function renderStrip(tabs: readonly TuiSessionTabView[], width: number): string[] {
  const segments = tabs.map((tab) => renderTabSegment(tab));
  const kept = fitSegments(segments, tabs, width);
  const keptIndexes = kept.flatMap((keep, index) => (keep ? [index] : []));
  const hidden = kept.length - keptIndexes.length;
  const overflow = hidden > 0 ? `+${String(hidden)}` : undefined;
  const activeIndex = keptIndexes.find((index) => tabs[index]?.active);
  const compose = (indexes: readonly number[], active?: string): string =>
    [
      ...indexes.map((index) =>
        index === activeIndex && active !== undefined
          ? renderTabSegment(tabs[index] as TuiSessionTabView, active)
          : (segments[index] as string),
      ),
      ...(overflow ? [chalk.hex(colors.dim)(overflow)] : []),
    ].join('  ');
  let row = compose(keptIndexes);
  if (activeIndex !== undefined && visibleWidth(row) > width) {
    // The visible tab must stay recognisable, so its own label shrinks before
    // the row is cut: a truncated row would hide the badge and the counter.
    const activeTab = tabs[activeIndex] as TuiSessionTabView;
    const fixedWidth =
      visibleWidth(renderTabSegment(activeTab, '')) +
      keptIndexes
        .filter((index) => index !== activeIndex)
        .reduce((total, index) => total + visibleWidth(segments[index] as string) + 2, 0) +
      (overflow ? visibleWidth(overflow) + 2 : 0);
    const labelBudget = width - fixedWidth;
    if (labelBudget >= 1) {
      row = compose(
        keptIndexes,
        truncateToWidth(activeTab.label, labelBudget, chalk.hex(colors.dim)('…')),
      );
    }
  }
  return [truncateToWidth(row, width, chalk.hex(colors.dim)('…'))];
}

/** Header row of a project group: fold marker, label, tab count, status. */
function renderGroupHeader(group: TuiSessionTabGroup, width: number): string {
  const held = group.tabs.some((tab) => tab.active);
  const marker = group.collapsed ? '▸' : '▾';
  const paint = held ? chalk.hex(colors.accent) : chalk.hex(colors.dim);
  const head = `${paint(`${marker} ${group.label}`)}${chalk.hex(colors.dim)(
    ` · ${String(group.tabs.length)}`,
  )}`;
  return truncateToWidth(
    `${head}${renderTabMarkers(group.status)}`,
    width,
    chalk.hex(colors.dim)('…'),
  );
}

/**
 * Groups to draw within the row budget. Drops from the end and never the group
 * holding the visible tab, which mirrors how tabs are dropped inside a row.
 */
function fitGroups(groups: readonly TuiSessionTabGroup[], budget: number): readonly boolean[] {
  const kept = groups.map(() => true);
  const rowCount = (): number =>
    groups.reduce(
      (total, group, index) => (kept[index] ? total + 1 + (group.collapsed ? 0 : 1) : total),
      0,
    );
  for (;;) {
    if (rowCount() <= budget) break;
    const index = findDroppableGroup(groups, kept);
    if (index === undefined) break;
    kept[index] = false;
  }
  return kept;
}

function findDroppableGroup(
  groups: readonly TuiSessionTabGroup[],
  kept: readonly boolean[],
): number | undefined {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (kept[index] && group && !group.tabs.some((tab) => tab.active)) return index;
  }
  return undefined;
}

/** Append the hidden-tab counter to a row that is already fitted. */
function appendCounter(row: string, hidden: number, width: number): string {
  const counter = chalk.hex(colors.dim)(`+${String(hidden)}`);
  const joined = `${row}  ${counter}`;
  if (visibleWidth(joined) <= width) return joined;
  const budget = width - visibleWidth(counter) - 2;
  if (budget < 1) return truncateToWidth(row, width, chalk.hex(colors.dim)('…'));
  return `${truncateToWidth(row, budget, chalk.hex(colors.dim)('…'))}  ${counter}`;
}

/**
 * Keep as many tabs as fit, dropping from the end and never the visible tab.
 * Returns one flag per tab in the original order.
 */
function fitSegments(
  segments: readonly string[],
  tabs: readonly TuiSessionTabView[],
  width: number,
): readonly boolean[] {
  const kept = tabs.map(() => true);
  const separatorWidth = 2;
  // The joined row adds one separator per kept segment, so the budget carries
  // one separator of slack; the overflow counter adds its own separator.
  const measure = (): number =>
    kept.reduce(
      (total, keep, index) =>
        keep ? total + visibleWidth(segments[index] ?? '') + separatorWidth : total,
      0,
    );
  for (;;) {
    const hidden = kept.filter((keep) => !keep).length;
    const counter = hidden > 0 ? visibleWidth(`+${String(hidden)}`) + separatorWidth : 0;
    if (measure() + counter <= width + separatorWidth) break;
    const index = findDroppableTab(tabs, kept);
    if (index === undefined) break;
    kept[index] = false;
  }
  return kept;
}

function findDroppableTab(
  tabs: readonly TuiSessionTabView[],
  kept: readonly boolean[],
): number | undefined {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    if (kept[index] && !tabs[index]?.active) return index;
  }
  return undefined;
}

/**
 * Render one tab. `labelOverride` carries an already-fitted label for the
 * visible tab, or an empty string when only the fixed parts are being measured.
 */
function renderTabSegment(tab: TuiSessionTabView, labelOverride?: string): string {
  const slot = tab.slot === undefined ? '·' : String(tab.slot);
  const slotLabel = chalk.hex(tab.active ? colors.accent : colors.dim)(`${slot}:`);
  const label = labelOverride ?? tab.label;
  const title = tab.unavailable ? `${label} ~` : label;
  const body = tab.active
    ? chalk.bold.hex(colors.text)(`[${title}]`)
    : chalk.hex(tab.unavailable ? colors.dim : colors.muted)(title);
  return `${slotLabel}${body}${renderTabMarkers(tab.status)}`;
}

function renderTabMarkers(status: TuiSessionTabStatus): string {
  const markers: string[] = [];
  if (status.blocked) markers.push(chalk.hex(colors.warning)('!'));
  if (status.running) markers.push(chalk.hex(colors.accent)('●'));
  if (status.unread > 0) {
    markers.push(chalk.hex(colors.success)(status.unread > 1 ? `•${status.unread}` : '•'));
  }
  return markers.length > 0 ? ` ${markers.join('')}` : '';
}
