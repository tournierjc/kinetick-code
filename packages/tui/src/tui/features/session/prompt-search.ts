import type { TuiSessionInputSummary } from '../../../runtime/port.js';

/** A saved user prompt that matched a Session, quoted back to the user. */
export interface TuiSessionHistoryMatch {
  readonly sessionId: string;
  readonly snippet: string;
}

/** Saved prompts read per Session. The runtime lists newest first. */
export const SESSION_PROMPT_SEARCH_LIMIT = 50;
/** Sessions searched at the same time. */
export const SESSION_PROMPT_SEARCH_CONCURRENCY = 8;

/**
 * The only session-history surface the runtime offers for a prompt search: the
 * persisted user prompts, head-truncated to 200 characters. There is no
 * full-text index, so a search reads prompts Session by Session.
 */
export interface TuiSessionPromptSearchPort {
  listSessionInputSummaries(
    sessionId: string,
    input?: { limit?: number; before?: string },
  ): Promise<readonly TuiSessionInputSummary[]>;
}

/** Split a query the same way the local title and metadata filter does. */
export function tokenizeSessionPromptQuery(query: string): readonly string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Find the Sessions whose saved user prompts contain every query token.
 *
 * A Session that cannot be read is skipped instead of failing the search: one
 * unreadable history must not hide every other match. Sessions are read a few at
 * a time so a large list cannot open hundreds of reads at once.
 */
export async function searchSessionPrompts(
  port: TuiSessionPromptSearchPort | undefined,
  query: string,
  sessionIds: readonly string[],
): Promise<readonly TuiSessionHistoryMatch[]> {
  const tokens = tokenizeSessionPromptQuery(query);
  if (!port || tokens.length === 0 || sessionIds.length === 0) return [];
  const queue = [...sessionIds];
  const matches: TuiSessionHistoryMatch[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const sessionId = queue.shift();
      if (sessionId === undefined) return;
      let summaries: readonly TuiSessionInputSummary[];
      try {
        summaries = await port.listSessionInputSummaries(sessionId, {
          limit: SESSION_PROMPT_SEARCH_LIMIT,
        });
      } catch {
        continue;
      }
      const hit = summaries.find((summary) => {
        const head = summary.contentHead?.toLocaleLowerCase() ?? '';
        return tokens.every((token) => head.includes(token));
      });
      const snippet = hit?.contentHead?.trim();
      if (snippet) matches.push({ sessionId, snippet });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SESSION_PROMPT_SEARCH_CONCURRENCY, queue.length) }, worker),
  );
  return matches;
}
