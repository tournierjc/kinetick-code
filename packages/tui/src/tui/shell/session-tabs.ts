/**
 * Session tab bar.
 *
 * A single chrome row listing the open Session tabs with their live state:
 * which one is visible, which one is working, which one is waiting for an
 * answer, and which ones finished a turn while another tab was on screen.
 *
 * The bar renders one row and never wraps: rows inside the conversation area
 * are part of the document frame, so a second row would move the transcript.
 * When the tabs do not fit, the trailing ones are replaced by a `+N` counter;
 * the visible tab is never the one that gets dropped.
 *
 * The resolver is separated from the component so tab selection and fitting can
 * be tested without a terminal.
 */

import type { Component } from '../rendering/component.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { TUI_TAB_DIRECT_SLOT_COUNT } from '../state/tabs.js';

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

export interface TuiSessionTabCatalogEntry {
  readonly sessionId: string;
  readonly title?: string;
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

export interface TuiSessionTabsOptions {
  /** Read on every render: the bar reflects the current state without a subscription. */
  readonly tabs: () => readonly TuiSessionTabView[];
  /** Fewer open tabs than this render no bar at all. */
  readonly minimumTabs?: number;
}

export class TuiSessionTabs implements Component {
  constructor(private readonly options: TuiSessionTabsOptions) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const tabs = this.options.tabs();
    if (tabs.length < (this.options.minimumTabs ?? 2)) return [];
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

  invalidate(): void {}
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
