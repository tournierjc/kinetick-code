/**
 * Idle-session knowledge proposals. After a root Session turn finishes, the
 * runtime may call this with the persisted user-prompt count and recent prompt
 * texts. Drafts are created only once the message threshold is met and the
 * Session has no pending proposal. Nothing is applied until a human approves
 * (and optionally edits) the draft.
 */

import type { KnowledgeProposalStore } from './proposal-store.js';

export interface IdleKnowledgeProposalSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title?: string;
  readonly messageCount: number;
  readonly recentUserTexts: readonly string[];
  readonly recentAssistantTexts?: readonly string[];
}

export interface IdleKnowledgeProposalOptions {
  readonly store: KnowledgeProposalStore;
  readonly minMessageCount?: number;
  readonly enabled?: boolean;
}

export async function createIdleKnowledgeProposals(
  session: IdleKnowledgeProposalSession,
  options: IdleKnowledgeProposalOptions,
): Promise<{ readonly created: number; readonly proposalIds: readonly string[] }> {
  if (options.enabled === false) return { created: 0, proposalIds: [] };
  const minMessageCount = options.minMessageCount ?? 8;
  if (session.messageCount < minMessageCount) return { created: 0, proposalIds: [] };

  const pending = await options.store.list({
    status: 'pending',
    sessionId: session.sessionId,
    limit: 20,
  });
  if (pending.length > 0) return { created: 0, proposalIds: [] };

  const themes = extractThemes(session.recentUserTexts);
  if (themes.length === 0) return { created: 0, proposalIds: [] };

  const evidence = session.recentUserTexts.slice(-3).map((text) => text.trim()).filter(Boolean);
  const themeLabel = themes.slice(0, 3).join(', ');
  const title = session.title?.trim() || `Session ${session.sessionId.slice(0, 8)}`;
  const proposalIds: string[] = [];

  const skill = await options.store.create({
    kind: 'skill',
    action: 'create',
    sessionId: session.sessionId,
    agentName: session.agentName,
    title: `Skill draft from idle session: ${title}`,
    summary: `Capture reusable guidance around: ${themeLabel}`,
    rationale:
      'Session became idle after enough turns to suggest a reusable Skill. Human review is required before any Skill file changes.',
    draft: [
      '---',
      `name: ${slugify(themes[0] ?? 'session-pattern')}`,
      `description: Reusable guidance distilled from session "${title}" about ${themeLabel}.`,
      '---',
      '',
      `# ${themes[0] ?? 'Session pattern'}`,
      '',
      '## When to use',
      `- User work touches: ${themeLabel}`,
      '',
      '## Steps',
      '1. Restate the goal and constraints from the conversation.',
      '2. Apply the recurring approach observed in this session.',
      '3. Verify outcomes before finishing.',
      '',
      '## Notes',
      '- Draft only — edit or reject during human review before applying.',
      '',
    ].join('\n'),
    evidenceExcerpts: evidence,
  });
  proposalIds.push(skill.id);

  const memory = await options.store.create({
    kind: 'memory',
    action: 'improve',
    sessionId: session.sessionId,
    agentName: session.agentName,
    title: `Memory draft from idle session: ${title}`,
    summary: `Persist durable preferences or facts about: ${themeLabel}`,
    rationale:
      'Session became idle with recurring themes that may belong in Memory. Human review is required before any Memory write.',
    draft: [
      `## From session ${session.sessionId}`,
      '',
      `- Themes: ${themeLabel}`,
      ...evidence.map((item) => `- Evidence: ${item.slice(0, 200)}`),
      '',
      'Edit this draft during review, then approve to append to Memory.',
      '',
    ].join('\n'),
    // Omitted targetRef appends agent Memory. Only `user` selects user Memory.
    evidenceExcerpts: evidence,
  });
  proposalIds.push(memory.id);

  return { created: proposalIds.length, proposalIds };
}

function extractThemes(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of text
      .toLocaleLowerCase('en-US')
      .split(/[^a-z0-9_+.-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([token]) => token);
  if (repeated.length > 0) return repeated;
  return [...counts.entries()]
    .filter(([token]) => token.length >= 5)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([token]) => token);
}

function slugify(value: string): string {
  const slug = value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return slug || 'session-pattern';
}
