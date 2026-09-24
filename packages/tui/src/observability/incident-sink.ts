/**
 * Incident sink contract for the TUI supervisor.
 *
 * This fork ships no automatic reporting: there is no upload path and no
 * account-linked diagnostic transport. What remains is the seam the TUI uses to
 * observe its own failures, so a supervising host (or a test) can still collect
 * incidents, and the call sites keep a typed contract instead of disappearing
 * into the render loop.
 *
 * The default sink is a no-op: local product logs remain the diagnostic surface
 * (`local-observability.ts`).
 */

export type TuiIncidentPhase = 'startup' | 'runtime' | 'shutdown';
export type TuiIncidentSeverity = 'fatal' | 'error' | 'warning';
export type TuiIncidentImpact = 'exit' | 'screen_unavailable' | 'action_failed' | 'degraded';
export type TuiIncidentEventType =
  | 'cli_process_error'
  | 'cli_startup_error'
  | 'cli_render_error'
  | 'cli_interaction_error'
  | 'cli_runtime_bridge_error'
  | 'cli_terminal_error'
  | 'cli_persistence_error'
  | 'cli_shutdown_error'
  | 'cli_unclean_exit';

export type TuiIncidentPrimitive = string | number | boolean | null;

export interface TuiIncidentCapture {
  readonly eventType: TuiIncidentEventType;
  readonly error: unknown;
  readonly component: string;
  readonly operation: string;
  readonly codeLocation: string;
  readonly severity?: TuiIncidentSeverity;
  readonly impact?: TuiIncidentImpact;
  readonly handled?: boolean;
  readonly phase?: TuiIncidentPhase;
  readonly context?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>;
}

export interface TuiIncidentSink {
  /** Returns an incident id when the sink retained the record. */
  capture(input: TuiIncidentCapture): string | undefined;
  breadcrumb(
    name: string,
    details?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>,
  ): void;
}

/**
 * Supervisor lifecycle around a sink. A host that installs a real sink owns the
 * run marker and flush semantics; the shipped default is the frozen no-op below.
 */
export interface TuiIncidentReporter extends TuiIncidentSink {
  readonly runId: string;
  readonly hasFatalIncident: boolean;
  setPhase(phase: TuiIncidentPhase): void;
  drain(): Promise<void>;
  flush(timeoutMs?: number): Promise<void>;
  completeRun(): void;
}

export const noopTuiIncidentSink: TuiIncidentReporter = Object.freeze({
  runId: '',
  hasFatalIncident: false,
  capture: () => undefined,
  breadcrumb: () => undefined,
  setPhase: () => undefined,
  drain: async () => undefined,
  flush: async () => undefined,
  completeRun: () => undefined,
});

/** Captures an incident without letting a sink failure reach the caller. */
export function captureTuiIncidentBestEffort(
  sink: TuiIncidentSink | undefined,
  input: TuiIncidentCapture,
): string | undefined {
  try {
    return sink?.capture(input);
  } catch {
    return undefined;
  }
}
