import type { TranscriptCell, TranscriptCellUpdate } from './model.js';
import type {
  TranscriptCellLocation,
  TranscriptProjectionSource,
  TranscriptTurnRange,
} from './projection-window.js';

export interface TranscriptActivitySource {
  readonly length: number;
  findVisibleError(error: string): { readonly turnId?: string } | undefined;
  latestSettledFailure(): { readonly turnId?: string } | undefined;
  hasConcreteTurnActivity(turnId: string): boolean;
}

/**
 * Session key used before a Session is active, and by callers with no Session of
 * their own (welcome chrome, app-local cells). It keeps the single-Session
 * behaviour of a store whose owner never calls `setActiveSession`.
 */
export const UNSCOPED_TRANSCRIPT_SESSION = 'session:none';

/** Cell bookkeeping for one Session. Everything here is per-Session. */
interface TranscriptSessionCells {
  readonly orderedIds: string[];
  readonly cells: Map<string, TranscriptCell>;
  readonly indexById: Map<string, number>;
  readonly turnStarts: number[];
  readonly pendingTextDeltas: Map<string, string>;
  readonly cellRevisions: Map<string, number>;
  revisionValue: number;
}

function createSessionCells(): TranscriptSessionCells {
  return {
    orderedIds: [],
    cells: new Map(),
    indexById: new Map(),
    turnStarts: [],
    pendingTextDeltas: new Map(),
    cellRevisions: new Map(),
    revisionValue: 0,
  };
}

/**
 * Cells of the Session on screen, plus the cells of every other Session the app
 * keeps.
 *
 * Reads describe the active Session only: `cellAt`, `snapshot`, `length`, the
 * turn ranges and the activity probes all resolve through `activeSessionId`, so a
 * view that renders the active Session needs no Session argument of its own.
 * Writes take an optional `sessionId`, which is how a background Session's cells
 * are kept without disturbing the pane on screen.
 *
 * Switching the active Session keeps both Sessions' cells: a Session that was
 * already projected is adopted again instead of cleared and rebuilt. The active
 * Session pointer and the retained cells are independent — `clear` empties one
 * Session, `dropSession` forgets it, and neither touches the other Sessions.
 */
export class TranscriptStore implements TranscriptProjectionSource, TranscriptActivitySource {
  private readonly sessions = new Map<string, TranscriptSessionCells>();
  private activeSession = UNSCOPED_TRANSCRIPT_SESSION;

  constructor(initialCells: readonly TranscriptCell[] = []) {
    for (const cell of initialCells) {
      this.upsert(cell);
    }
  }

  /** Session the reads below describe. */
  get activeSessionId(): string {
    return this.activeSession;
  }

  /**
   * Point the reads at `sessionId`, creating its cell list on first use. The
   * Session being left keeps its cells. `revision` is bumped so a reader that
   * caches by revision re-renders for the Session it now describes.
   */
  setActiveSession(sessionId: string): void {
    if (this.activeSession === sessionId) return;
    this.activeSession = sessionId;
    this.state(sessionId).revisionValue += 1;
  }

  /** Whether `sessionId` already holds cells in this store. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Sessions currently retained, in creation order. */
  sessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /** Forget one Session's cells. Returns false when nothing was retained. */
  dropSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Move a Session's cells to another Session, replacing what that Session held.
   * Used when the pane learns which Session it belongs to: content written while no
   * Session was visible becomes that Session's content, exactly as a single-pane
   * store behaved when it learned the Session id.
   */
  moveSession(from: string, to: string): boolean {
    if (from === to) return false;
    const source = this.sessions.get(from);
    this.sessions.delete(from);
    if (!source) return false;
    this.sessions.set(to, source);
    source.revisionValue += 1;
    if (this.activeSession === from) this.activeSession = to;
    return true;
  }

  get(id: string): TranscriptCell | undefined {
    const cell = this.state().cells.get(id);
    return cell ? { ...cell } : undefined;
  }

  get length(): number {
    return this.state().orderedIds.length;
  }

  get revision(): number {
    return this.state().revisionValue;
  }

  cellRevision(cell: TranscriptCell): number | undefined {
    const state = this.state();
    return state.cells.get(cell.id) === cell ? state.cellRevisions.get(cell.id) : undefined;
  }

  get turnCount(): number {
    return this.state().turnStarts.length;
  }

  cellAt(index: number): TranscriptCell | undefined {
    const state = this.state();
    const id = state.orderedIds[index];
    return id === undefined ? undefined : state.cells.get(id);
  }

  locateCell(id: string): TranscriptCellLocation | undefined {
    const state = this.state();
    const index = state.indexById.get(id);
    if (index === undefined) return undefined;
    return { index, turnIndex: findTurnIndex(index, state) };
  }

  turnRange(turnIndex: number): TranscriptTurnRange | undefined {
    const state = this.state();
    const start = state.turnStarts[turnIndex];
    if (start === undefined) return undefined;
    return {
      start,
      end: state.turnStarts[turnIndex + 1] ?? state.orderedIds.length,
    };
  }

  snapshot(): TranscriptCell[] {
    return snapshotOf(this.state());
  }

  findVisibleError(error: string): { readonly turnId?: string } | undefined {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (cell?.kind !== 'error' || cell.content.trim() !== error) continue;
      return cell.turnId ? { turnId: cell.turnId } : {};
    }
    return undefined;
  }

  latestSettledFailure(): { readonly turnId?: string } | undefined {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (!cell?.turnId) continue;
      if (cell.status === 'pending' || cell.status === 'running') return undefined;
      if (cell.kind === 'error' && cell.status === 'failed') return { turnId: cell.turnId };
      return undefined;
    }
    return undefined;
  }

  hasConcreteTurnActivity(turnId: string): boolean {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      const cell = this.cellAt(index);
      if (!cell || cell.turnId !== turnId) continue;
      if (cell.status !== 'pending' && cell.status !== 'running') continue;
      if (cell.kind === 'tool') return true;
      if (
        (cell.kind === 'thinking' ||
          cell.kind === 'assistant' ||
          cell.kind === 'assistant-preamble') &&
        cell.content.trim()
      ) {
        return true;
      }
    }
    return false;
  }

  upsert(update: TranscriptCellUpdate, sessionId: string = this.activeSession): TranscriptCell {
    const state = this.state(sessionId);
    const current = state.cells.get(update.id);
    const next = current ? mergeCell(current, update) : requireCompleteCell(update);

    if (!current) {
      const index = state.orderedIds.length;
      const idBefore = state.orderedIds[index - 1];
      const previous = idBefore === undefined ? undefined : state.cells.get(idBefore);
      state.orderedIds.push(next.id);
      state.indexById.set(next.id, index);
      if (!previous || turnKey(previous) !== turnKey(next)) state.turnStarts.push(index);
    }
    state.cells.set(next.id, next);
    if (current && turnKey(current) !== turnKey(next)) rebuildIndexes(state);
    state.revisionValue += 1;
    state.cellRevisions.set(next.id, state.revisionValue);
    return { ...next };
  }

  remove(id: string, sessionId: string = this.activeSession): boolean {
    const state = this.state(sessionId);
    if (!state.cells.delete(id)) return false;
    state.cellRevisions.delete(id);
    const index = state.orderedIds.indexOf(id);
    if (index >= 0) state.orderedIds.splice(index, 1);
    state.pendingTextDeltas.delete(id);
    rebuildIndexes(state);
    state.revisionValue += 1;
    return true;
  }

  moveBefore(id: string, anchorId: string, sessionId: string = this.activeSession): boolean {
    const state = this.state(sessionId);
    const sourceIndex = state.indexById.get(id);
    const anchorIndex = state.indexById.get(anchorId);
    if (
      sourceIndex === undefined ||
      anchorIndex === undefined ||
      sourceIndex === anchorIndex ||
      sourceIndex + 1 === anchorIndex
    ) {
      return false;
    }
    state.orderedIds.splice(sourceIndex, 1);
    const nextAnchorIndex = state.orderedIds.indexOf(anchorId);
    state.orderedIds.splice(nextAnchorIndex, 0, id);
    rebuildIndexes(state);
    state.revisionValue += 1;
    return true;
  }

  moveToEnd(id: string, sessionId: string = this.activeSession): boolean {
    const state = this.state(sessionId);
    const sourceIndex = state.indexById.get(id);
    if (sourceIndex === undefined || sourceIndex === state.orderedIds.length - 1) return false;
    state.orderedIds.splice(sourceIndex, 1);
    state.orderedIds.push(id);
    rebuildIndexes(state);
    state.revisionValue += 1;
    return true;
  }

  queueTextDelta(id: string, delta: string, sessionId: string = this.activeSession): void {
    if (!delta) return;
    const state = this.state(sessionId);
    if (!state.cells.has(id)) {
      throw new Error(`Cannot queue transcript delta for unknown cell: ${id}`);
    }
    state.pendingTextDeltas.set(id, `${state.pendingTextDeltas.get(id) ?? ''}${delta}`);
  }

  flushTextDeltas(updatedAtMs: number, sessionId: string = this.activeSession): string[] {
    const state = this.state(sessionId);
    const updatedIds: string[] = [];

    for (const [id, delta] of state.pendingTextDeltas) {
      const cell = state.cells.get(id);
      if (!cell) continue;
      state.cells.set(id, {
        ...cell,
        content: `${cell.content}${delta}`,
        updatedAtMs,
      });
      updatedIds.push(id);
      state.cellRevisions.set(id, state.revisionValue + 1);
    }

    state.pendingTextDeltas.clear();
    if (updatedIds.length > 0) state.revisionValue += 1;
    return updatedIds;
  }

  /**
   * Clear one Session's cells. The other Sessions and the active pointer stay, so
   * this is safe for a pane that is not the one on screen.
   */
  clear(sessionId: string = this.activeSession): void {
    const state = this.state(sessionId);
    const hadCells = state.orderedIds.length > 0;
    state.orderedIds.length = 0;
    state.cells.clear();
    state.cellRevisions.clear();
    state.indexById.clear();
    state.turnStarts.length = 0;
    state.pendingTextDeltas.clear();
    if (hadCells) state.revisionValue += 1;
  }

  replaceDurableProjection(
    projectDurable: () => void,
    sessionId: string = this.activeSession,
  ): void {
    const state = this.state(sessionId);
    const current = snapshotOf(state);
    let durableBefore = 0;
    const retained = current.flatMap((cell, index) => {
      if (!retainsAcrossReconcile(cell)) {
        durableBefore += 1;
        return [];
      }
      return [
        {
          cell,
          previousDurableId: findDurableId(current, index, -1),
          nextDurableId: findDurableId(current, index, 1),
          durableBefore,
        },
      ];
    });

    this.clear(sessionId);
    try {
      projectDurable();
    } finally {
      const projectedDurableIds = state.orderedIds.filter((id) => {
        const cell = state.cells.get(id);
        return cell !== undefined && !retainsAcrossReconcile(cell);
      });
      const anchors = retained.map(
        ({ previousDurableId, nextDurableId, durableBefore: durableCountBefore }) => {
          if (nextDurableId && state.cells.has(nextDurableId)) return nextDurableId;
          if (previousDurableId) {
            const previousIndex = state.indexById.get(previousDurableId);
            if (previousIndex !== undefined) return state.orderedIds[previousIndex + 1];
          }
          return projectedDurableIds[durableCountBefore];
        },
      );
      retained.forEach(({ cell }, index) => {
        if (state.cells.has(cell.id)) return;
        this.upsert(cell, sessionId);
        const anchor = anchors[index];
        if (anchor) this.moveBefore(cell.id, anchor, sessionId);
      });
    }
  }

  private state(sessionId: string = this.activeSession): TranscriptSessionCells {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = createSessionCells();
    this.sessions.set(sessionId, created);
    return created;
  }
}

function snapshotOf(state: TranscriptSessionCells): TranscriptCell[] {
  return state.orderedIds.flatMap((id) => {
    const cell = state.cells.get(id);
    return cell ? [{ ...cell }] : [];
  });
}

function findDurableId(
  cells: readonly TranscriptCell[],
  startIndex: number,
  direction: -1 | 1,
): string | undefined {
  for (let index = startIndex + direction; index >= 0 && index < cells.length; index += direction) {
    const cell = cells[index];
    if (cell && !retainsAcrossReconcile(cell)) return cell.id;
  }
  return undefined;
}

/**
 * Whether a cell survives a durable re-projection. Durable content is replaced
 * wholesale, so a cell that the durable projection does not carry must be kept if
 * re-projecting would lose something the pane is showing: local/ephemeral cells,
 * and the cells of a turn that is still streaming — a running turn's output is not
 * durable yet, so re-projecting without them is what makes a revisited Session lose
 * the tail of its live turn.
 */
function retainsAcrossReconcile(cell: TranscriptCell): boolean {
  if (cell.ephemeral) return true;
  return cell.status === 'pending' || cell.status === 'running';
}

function turnKey(cell: TranscriptCell): string {
  return cell.turnId?.trim() || `cell:${cell.id}`;
}

function findTurnIndex(cellIndex: number, state: TranscriptSessionCells): number {
  let low = 0;
  let high = state.turnStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((state.turnStarts[middle] ?? 0) <= cellIndex) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function rebuildIndexes(state: TranscriptSessionCells): void {
  state.indexById.clear();
  state.turnStarts.length = 0;
  let previousTurn: string | undefined;
  state.orderedIds.forEach((id, index) => {
    state.indexById.set(id, index);
    const cell = state.cells.get(id);
    if (!cell) return;
    const turn = turnKey(cell);
    if (turn !== previousTurn) state.turnStarts.push(index);
    previousTurn = turn;
  });
}

function mergeCell(current: TranscriptCell, update: TranscriptCellUpdate): TranscriptCell {
  return {
    ...current,
    ...update,
    id: current.id,
    createdAtMs: current.createdAtMs,
  };
}

function requireCompleteCell(update: TranscriptCellUpdate): TranscriptCell {
  if (
    update.kind === undefined ||
    update.status === undefined ||
    update.content === undefined ||
    update.createdAtMs === undefined
  ) {
    throw new Error(`New transcript cell ${update.id} is missing required fields`);
  }

  return {
    ...update,
    kind: update.kind,
    status: update.status,
    content: update.content,
    createdAtMs: update.createdAtMs,
    updatedAtMs: update.updatedAtMs ?? update.createdAtMs,
  };
}
