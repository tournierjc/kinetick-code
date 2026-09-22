import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  getDefaultTuiKeybindingRegistry,
  resolveTuiKeybinding,
  resolveTuiTabSlot,
  type TuiKeybindingContext,
} from '../../src/tui/shell/keybindings.js';
import {
  IDLE_TUI_SESSION_TAB_STATUS,
  resolveTuiSessionTabStatus,
  resolveTuiSessionTabs,
  TuiSessionTabs,
  type TuiSessionTabStatus,
  type TuiSessionTabView,
} from '../../src/tui/shell/session-tabs.js';

const IDLE_CONTEXT: TuiKeybindingContext = {
  interactionActive: false,
  hasLiveRun: false,
};

function tab(overrides: Partial<TuiSessionTabView> & { sessionId: string }): TuiSessionTabView {
  return {
    label: overrides.sessionId,
    active: false,
    status: IDLE_TUI_SESSION_TAB_STATUS,
    unavailable: false,
    ...overrides,
  };
}

function render(tabs: readonly TuiSessionTabView[], width = 100): string {
  return stripVTControlCharacters(new TuiSessionTabs({ tabs: () => tabs }).render(width).join('\n'));
}

function statusOf(overrides: Partial<TuiSessionTabStatus> = {}): TuiSessionTabStatus {
  return { running: false, blocked: false, unread: 0, ...overrides };
}

describe('resolveTuiSessionTabs', () => {
  it('resolves titles, slots and the visible tab in tab order', () => {
    const tabs = resolveTuiSessionTabs({
      order: ['a', 'b'],
      activeSessionId: 'b',
      catalog: [
        { sessionId: 'a', title: 'Fix the login flow' },
        { sessionId: 'b', title: 'Refactor the runtime' },
      ],
      statusOf: () => undefined,
    });

    expect(tabs.map((entry) => entry.slot)).toEqual([1, 2]);
    expect(tabs.map((entry) => entry.active)).toEqual([false, true]);
    expect(tabs.map((entry) => entry.label)).toEqual(['Fix the login flow', 'Refactor the runtime']);
  });

  it('drops the direct slot for tabs past the ninth and marks missing Sessions', () => {
    const order = Array.from({ length: 11 }, (_, index) => `s${index}`);
    const tabs = resolveTuiSessionTabs({
      order,
      catalog: [{ sessionId: 's0', title: 'Present' }],
      statusOf: () => undefined,
    });

    expect(tabs[8]?.slot).toBe(9);
    expect(tabs[9]?.slot).toBeUndefined();
    expect(tabs[0]?.unavailable).toBe(false);
    expect(tabs[1]?.unavailable).toBe(true);
  });

  it('falls back to a placeholder title and sanitizes control characters', () => {
    const tabs = resolveTuiSessionTabs({
      order: ['a', 'b'],
      catalog: [
        { sessionId: 'a' },
        { sessionId: 'b', title: '\u001b[31mInjected' },
      ],
      statusOf: () => undefined,
    });

    expect(tabs[0]?.label).toBe('Untitled session');
    expect(tabs[1]?.label).not.toContain('\u001b');
  });
});

describe('resolveTuiSessionTabStatus', () => {
  it('reports an idle Session without a view', () => {
    expect(resolveTuiSessionTabStatus(undefined)).toEqual(IDLE_TUI_SESSION_TAB_STATUS);
  });

  it.each(['running', 'starting', 'blocked'])('reports %s runs as busy', (status) => {
    const view = resolveTuiSessionTabStatus({
      execution: { runs: new Map([['t1', { status }]]) },
      attention: { permission: false, question: false, unread: 0 },
    });

    expect(view.running).toBe(true);
  });

  it('reports a terminal run as idle', () => {
    const view = resolveTuiSessionTabStatus({
      execution: { runs: new Map([['t1', { status: 'terminal' }]]) },
      attention: { permission: false, question: false, unread: 0 },
    });

    expect(view.running).toBe(false);
  });

  it('reports pending answers and unread turns', () => {
    expect(
      resolveTuiSessionTabStatus({
        execution: { runs: new Map() },
        attention: { permission: true, question: false, unread: 0 },
      }).blocked,
    ).toBe(true);
    expect(
      resolveTuiSessionTabStatus({
        execution: { runs: new Map() },
        attention: { permission: false, question: true, unread: 0 },
      }).blocked,
    ).toBe(true);
    expect(
      resolveTuiSessionTabStatus({
        execution: { runs: new Map() },
        attention: { permission: false, question: false, unread: 3 },
      }).unread,
    ).toBe(3);
  });
});

describe('TuiSessionTabs', () => {
  it('renders nothing for a single tab or an empty bar', () => {
    expect(render([tab({ sessionId: 'a', active: true })])).toBe('');
    expect(render([])).toBe('');
    expect(render([], 0)).toBe('');
  });

  it('respects a higher minimum tab count', () => {
    const bar = new TuiSessionTabs({
      tabs: () => [tab({ sessionId: 'a', active: true }), tab({ sessionId: 'b' })],
      minimumTabs: 3,
    });

    expect(bar.render(80)).toEqual([]);
  });

  it('marks the visible tab and lists the others', () => {
    const row = render([
      tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
      tab({ sessionId: 'b', label: 'Two', slot: 2 }),
    ]);

    expect(row).toBe('1:[One]  2:Two');
  });

  it('renders busy, blocked and unread markers', () => {
    const row = render([
      tab({ sessionId: 'a', label: 'Busy', active: true, slot: 1, status: statusOf({ running: true }) }),
      tab({ sessionId: 'b', label: 'Waiting', slot: 2, status: statusOf({ blocked: true }) }),
      tab({ sessionId: 'c', label: 'Unread', slot: 3, status: statusOf({ unread: 2 }) }),
      tab({ sessionId: 'd', label: 'One', slot: 4, status: statusOf({ unread: 1 }) }),
    ]);

    expect(row).toBe('1:[Busy] ●  2:Waiting !  3:Unread •2  4:One •');
  });

  it('marks a tab whose Session is gone from the catalog', () => {
    const row = render([
      tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
      tab({ sessionId: 'b', label: 'Gone', slot: 2, unavailable: true }),
    ]);

    expect(row).toBe('1:[One]  2:Gone ~');
  });

  it('uses a placeholder for tabs past the direct slots', () => {
    const row = render([
      tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
      tab({ sessionId: 'b', label: 'Two' }),
    ]);

    expect(row).toBe('1:[One]  ·:Two');
  });

  it('never renders wider than the terminal', () => {
    const tabs = Array.from({ length: 6 }, (_, index) =>
      tab({
        sessionId: `s${index}`,
        label: `A fairly long session title number ${index}`,
        active: index === 0,
        slot: index + 1,
      }),
    );

    for (const width of [12, 24, 40]) {
      const row = render(tabs, width);
      expect(row.length).toBeLessThanOrEqual(width);
      expect(row).toContain('[');
      expect(row).toMatch(/\+\d+/u);
    }

    expect(render(tabs, 61)).toContain('[A fairly long session title number 0]');
  });

  it('shrinks the visible label instead of cutting the row', () => {
    const row = render(
      [
        tab({ sessionId: 'a', label: 'A fairly long session title', active: true, slot: 1 }),
        tab({ sessionId: 'b', label: 'Another long session title', slot: 2 }),
      ],
      24,
    );

    expect(row.length).toBeLessThanOrEqual(24);
    expect(row).toContain('[');
    expect(row).toContain('…');
    expect(row).toMatch(/\+1$/u);
  });

  it('keeps the active tab even when it is the last one', () => {
    const row = render(
      [
        tab({ sessionId: 'a', label: 'A very long first session title', slot: 1 }),
        tab({ sessionId: 'b', label: 'A very long second session title', slot: 2 }),
        tab({ sessionId: 'c', label: 'Active', active: true, slot: 3 }),
      ],
      26,
    );

    expect(row).toBe('3:[Active]  +2');
  });

  it('drops the trailing tabs in order', () => {
    const row = render(
      [
        tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
        tab({ sessionId: 'b', label: 'Two', slot: 2 }),
        tab({ sessionId: 'c', label: 'Three', slot: 3 }),
        tab({ sessionId: 'd', label: 'Four', slot: 4 }),
      ],
      24,
    );

    expect(row).toBe('1:[One]  2:Two  +2');
  });
});

describe('tab keybindings', () => {
  it('cycles with the legacy and Kitty forms of the arrow keys', () => {
    expect(resolveTuiKeybinding('\u001b[1;6C', IDLE_CONTEXT)).toBe('next-tab');
    expect(resolveTuiKeybinding('\u001b[1;6D', IDLE_CONTEXT)).toBe('previous-tab');
  });

  it('does not steal the plain shift+left restore binding', () => {
    const waitingContext: TuiKeybindingContext = {
      interactionActive: false,
      hasLiveRun: true,
      hasWaitingMessage: true,
    };

    expect(resolveTuiKeybinding('\u001b[1;2D', waitingContext)).toBe('restore-waiting');
    expect(resolveTuiKeybinding('\u001b[1;6D', waitingContext)).toBe('previous-tab');
  });

  it('closes the visible tab with alt+w', () => {
    expect(resolveTuiKeybinding('\u001bw', IDLE_CONTEXT)).toBe('close-tab');
  });

  it('resolves every direct slot, and only those', () => {
    const registry = getDefaultTuiKeybindingRegistry();
    for (let slot = 1; slot <= 9; slot += 1) {
      const data = `\u001b${String(slot)}`;
      expect(resolveTuiKeybinding(data, IDLE_CONTEXT)).toBe('switch-tab-slot');
      expect(resolveTuiTabSlot(data, IDLE_CONTEXT)).toBe(slot);
      expect(registry.resolveTabSlot(data, IDLE_CONTEXT)).toBe(slot);
    }
    expect(registry.get('tabs.slot-10')).toBeUndefined();
  });

  it('resolves tab bindings while a feature panel owns the screen', () => {
    const panelContext: TuiKeybindingContext = { interactionActive: true, hasLiveRun: true };

    expect(resolveTuiKeybinding('\u001b[1;6C', panelContext)).toBe('next-tab');
    expect(resolveTuiTabSlot('\u001b2', panelContext)).toBe(2);
  });

  it('ignores key releases', () => {
    expect(resolveTuiTabSlot('\u001b2', IDLE_CONTEXT)).toBe(2);
    expect(resolveTuiTabSlot('\u001b2;3:3u', IDLE_CONTEXT)).toBeUndefined();
  });

  it('lists the tab keys in the help rows', () => {
    const rows = getDefaultTuiKeybindingRegistry().helpRows();
    const cycle = rows.find((row) => row.ids.includes('tabs.next'));

    expect(cycle?.ids).toEqual(['tabs.previous', 'tabs.next']);
    expect(cycle?.keys).toContain('/');
    expect(rows.find((row) => row.ids.includes('tabs.close'))?.description).toBe(
      'Close the visible Session tab',
    );
    expect(rows.find((row) => row.ids.includes('tabs.slot-1'))?.description).toBe(
      'Switch to the Session tab in slot 1-9',
    );
  });
});
