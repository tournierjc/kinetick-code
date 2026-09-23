export type KcodeUpdatePhase =
  | 'checking'
  | 'downloading'
  | 'staging'
  | 'installing'
  | 'validating'
  | 'activating'
  | 'completed';

export interface KcodeUpdatePhaseEvent {
  readonly phase: KcodeUpdatePhase;
  readonly cancellable: boolean;
}

export interface KcodeUpdateOperationOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: string) => void;
  readonly onPhase?: (event: KcodeUpdatePhaseEvent) => void;
}

export class KcodeUpdateCancelledError extends Error {
  constructor(message = 'KCode update cancelled; the previous installation remains active.') {
    super(message);
    this.name = 'McodeUpdateCancelledError';
  }
}

export class KcodeUpdateAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McodeUpdateAdmissionError';
  }
}

export function throwIfKcodeUpdateCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KcodeUpdateCancelledError();
}

export function reportKcodeUpdatePhase(
  options: Pick<KcodeUpdateOperationOptions, 'onPhase'>,
  phase: KcodeUpdatePhase,
  cancellable: boolean,
): void {
  try {
    options.onPhase?.({ phase, cancellable });
  } catch {
    // Presentation observers must not change update safety or outcome.
  }
}

export function isKcodeUpdateCancelledError(error: unknown): error is KcodeUpdateCancelledError {
  return error instanceof KcodeUpdateCancelledError;
}

export function isKcodeUpdateAdmissionError(error: unknown): error is KcodeUpdateAdmissionError {
  return error instanceof KcodeUpdateAdmissionError;
}
