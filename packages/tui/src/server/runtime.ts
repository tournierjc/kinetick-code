import type { TuiSessionPort } from '../runtime/port.js';

/** Runtime capabilities consumed by the session server. */
export type TuiServerRuntime = Pick<
  TuiSessionPort,
  'listSessionPage' | 'getSession' | 'listMessagePage'
>;
