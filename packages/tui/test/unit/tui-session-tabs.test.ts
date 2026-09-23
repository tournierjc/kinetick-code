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
  resolveTuiSessionTabGroupRef,
  resolveTuiSessionTabGroupRefs,
  resolveTuiSessionTabGroups,
  resolveTuiSessionTabStatus,
  resolveTuiSessionTabs,
  TuiSessionTabs,
  TUI_TAB_UNGROUPED_KEY,
  type TuiSessionTabGroup,
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

function render(
  tabs: readonly TuiSessionTabView[],
  width = 100,
  groups?: readonly TuiSessionTabGroup[],
): string {
  const model = groups ? { tabs, groups } : { tabs };
  return stripVTControlCharacters(
    new TuiSessionTabs({ tabs: () => model }).render(width).join('\n'),
  );
}

/** Group the given tabs by the project each one carries in its sessionId. */
function groupTabs(
  tabs: readonly TuiSessionTabView[],
  projects: Readonly<Record<string, string>>,
): readonly TuiSessionTabGroup[] | undefined {
  const refs = resolveTuiSessionTabGroupRefs(
    Object.entries(projects).map(([sessionId, workspaceDir]) => ({ sessionId, workspaceDir })),
  );
  return resolveTuiSessionTabGroups({
    tabs,
    groupOf: (sessionId) => refs.get(sessionId),
    collapsedGroups: [],
  });
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
      tabs: () => ({ tabs: [tab({ sessionId: 'a', active: true }), tab({ sessionId: 'b' })] }),
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

  it('resolves rename, grouping and collapse', () => {
    expect(resolveTuiKeybinding('\u001br', IDLE_CONTEXT)).toBe('rename-tab');
    expect(resolveTuiKeybinding('\u001bg', IDLE_CONTEXT)).toBe('toggle-tab-grouping');
    expect(resolveTuiKeybinding('\u001bh', IDLE_CONTEXT)).toBe('toggle-tab-collapse');
    expect(resolveTuiKeybinding('\u001br', { interactionActive: true, hasLiveRun: true })).toBe(
      'rename-tab',
    );
  });

  it('lists the grouping keys separately from the cycle row', () => {
    const rows = getDefaultTuiKeybindingRegistry().helpRows();

    for (const [id, description, key] of [
      ['tabs.rename', 'Rename the visible Session tab', 'R'],
      ['tabs.grouping', 'Group the Session tabs by project', 'G'],
      ['tabs.collapse', 'Fold every other project group, or unfold them all', 'H'],
    ]) {
      const row = rows.find((candidate) => candidate.ids.includes(id));

      expect(row?.ids).toEqual([id]);
      expect(row?.description).toBe(description);
      expect(row?.keys).toContain(key);
    }
  });
});

describe('resolveTuiSessionTabGroupRef', () => {
  it('keys a project by its workspace directory and labels it by the folder', () => {
    expect(resolveTuiSessionTabGroupRef('/opt/data/work/kinetick-code')).toEqual({
      key: '/opt/data/work/kinetick-code',
      label: 'kinetick-code',
    });
  });

  it('ignores a trailing separator and Windows separators', () => {
    expect(resolveTuiSessionTabGroupRef('/work/api/')).toEqual({
      key: '/work/api',
      label: 'api',
    });
    expect(resolveTuiSessionTabGroupRef('C:\\work\\api')).toEqual({
      key: 'C:\\work\\api',
      label: 'api',
    });
  });

  it('groups a Session without a workspace under one shared key', () => {
    expect(resolveTuiSessionTabGroupRef(undefined)).toEqual({
      key: TUI_TAB_UNGROUPED_KEY,
      label: 'No project',
    });
    expect(resolveTuiSessionTabGroupRef('  ')).toEqual({
      key: TUI_TAB_UNGROUPED_KEY,
      label: 'No project',
    });
  });
});

describe('resolveTuiSessionTabGroups', () => {
  function tabsWithProjects(): {
    tabs: readonly TuiSessionTabView[];
    projects: Record<string, string>;
  } {
    return {
      tabs: [
        tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
        tab({ sessionId: 'b', label: 'Two', slot: 2 }),
        tab({ sessionId: 'c', label: 'Three', slot: 3 }),
      ],
      projects: { a: '/work/api', b: '/work/web', c: '/work/api' },
    };
  }

  it('splits the tabs by project, keeping bar order', () => {
    const { tabs, projects } = tabsWithProjects();
    const groups = groupTabs(tabs, projects);

    expect(groups?.map((group) => group.key)).toEqual(['/work/api', '/work/web']);
    expect(groups?.map((group) => group.label)).toEqual(['api', 'web']);
    expect(groups?.[0]?.tabs.map((entry) => entry.sessionId)).toEqual(['a', 'c']);
    expect(groups?.[1]?.tabs.map((entry) => entry.sessionId)).toEqual(['b']);
  });

  it('returns nothing to group when every tab shares one project', () => {
    expect(groupTabs([tab({ sessionId: 'a' }), tab({ sessionId: 'b' })], { a: '/work/api', b: '/work/api' }))
      .toBeUndefined();
  });

  it('folds only the requested group, never the visible one', () => {
    const { tabs, projects } = tabsWithProjects();
    const refs = resolveTuiSessionTabGroupRefs(
      Object.entries(projects).map(([sessionId, workspaceDir]) => ({ sessionId, workspaceDir })),
    );
    const groups = resolveTuiSessionTabGroups({
      tabs,
      groupOf: (sessionId) => refs.get(sessionId),
      collapsedGroups: ['/work/api', '/work/web'],
    });

    // `a` is the visible tab and lives in `/work/api`, so that group stays open.
    expect(groups?.map((group) => group.collapsed)).toEqual([false, true]);
  });

  it('combines the tab statuses so a folded group still shows activity', () => {
    const tabs = [
      tab({ sessionId: 'a', active: true, status: statusOf({ running: true, unread: 1 }) }),
      tab({ sessionId: 'b', status: statusOf({ blocked: true, unread: 2 }) }),
      tab({ sessionId: 'c', label: 'Three', status: statusOf({ unread: 3 }) }),
    ];
    const groups = groupTabs(tabs, { a: '/work/api', b: '/work/api', c: '/work/web' });

    expect(groups?.[0]?.status).toEqual({ running: true, blocked: true, unread: 3 });
    expect(groups?.[1]?.status).toEqual({ running: false, blocked: false, unread: 3 });
  });
});

describe('TuiSessionTabs grouping', () => {
  const tabs = [
    tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
    tab({ sessionId: 'b', label: 'Two', slot: 2 }),
    tab({ sessionId: 'c', label: 'Three', slot: 3 }),
  ];
  const projects = { a: '/work/api', b: '/work/web', c: '/work/api' };

  it('draws a project header above each group of tabs', () => {
    const groups = groupTabs(tabs, projects);
    const rows = render(tabs, 100, groups).split('\n');

    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe('▾ api · 2');
    expect(rows[1]).toBe('1:[One]  3:Three');
    expect(rows[2]).toBe('▾ web · 1');
    expect(rows[3]).toBe('2:Two');
  });

  it('draws only the header for a folded group', () => {
    const refs = resolveTuiSessionTabGroupRefs(
      Object.entries(projects).map(([sessionId, workspaceDir]) => ({ sessionId, workspaceDir })),
    );
    const groups = resolveTuiSessionTabGroups({
      tabs,
      groupOf: (sessionId) => refs.get(sessionId),
      collapsedGroups: ['/work/web'],
    });
    const folded = groups?.map((group, index) =>
      index === 1 ? { ...group, collapsed: true } : group,
    );
    const rows = render(tabs, 100, folded).split('\n');

    expect(rows).toEqual(['▾ api · 2', '1:[One]  3:Three', '▸ web · 1']);
  });

  it('shows the combined status on a folded group header', () => {
    const statusTabs = [
      tab({ sessionId: 'a', label: 'One', active: true, slot: 1 }),
      tab({ sessionId: 'b', label: 'Two', slot: 2, status: statusOf({ blocked: true }) }),
      tab({ sessionId: 'c', label: 'Three', slot: 3 }),
    ];
    const folded = [
      {
        key: '/work/api',
        label: 'api',
        collapsed: false,
        tabs: [statusTabs[0] as TuiSessionTabView],
        status: IDLE_TUI_SESSION_TAB_STATUS,
      },
      {
        key: '/work/web',
        label: 'web',
        collapsed: true,
        tabs: [statusTabs[1] as TuiSessionTabView],
        status: statusOf({ blocked: true, unread: 2 }),
      },
    ];
    const rows = render(statusTabs, 100, folded).split('\n');

    expect(rows[2]).toBe('▸ web · 1 !•2');
  });

  it('drops trailing groups past the row budget and counts their tabs', () => {
    const many = ['a', 'b', 'c', 'd'].map((sessionId, index) =>
      tab({ sessionId, label: sessionId, slot: index + 1 }),
    );
    const grouped = groupTabs(many, {
      a: '/work/api',
      b: '/work/web',
      c: '/work/docs',
      d: '/work/infra',
    });
    const bar = new TuiSessionTabs({ tabs: () => ({ tabs: many, groups: grouped }), maximumRows: 5 });

    const rows = stripVTControlCharacters(bar.render(120).join('\n')).split('\n');

    // Four groups need eight rows; the budget keeps two groups and counts the rest.
    expect(rows).toEqual(['▾ api · 1', '1:a', '▾ web · 1', '2:b  +2']);
  });

  it('renders a single strip when the tabs share one project', () => {
    const single = [
      tab({ sessionId: 'a', active: true, slot: 1 }),
      tab({ sessionId: 'b', slot: 2 }),
    ];
    const groups = groupTabs(single, { a: '/work/api', b: '/work/api' });

    expect(groups).toBeUndefined();
    expect(render(single, 100, groups)).toBe('1:[a]  2:b');
  });
});
