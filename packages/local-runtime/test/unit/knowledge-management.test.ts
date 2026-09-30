import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIdleKnowledgeProposals } from '../../src/knowledge/idle-proposals.js';
import {
  KnowledgeProposalError,
  KnowledgeProposalStore,
} from '../../src/knowledge/proposal-store.js';
import { createKnowledgeReviewApplication } from '../../src/knowledge/review-application.js';
import {
  formatPromptMemoryLookup,
  matchMemoryForPrompt,
} from '../../src/memory/prompt-memory-lookup.js';
import {
  applyPromptSkillSessionPolicy,
  formatPromptSkillMatchReminder,
  matchSkillsForPrompt,
  tokenizePromptLookupText,
} from '../../src/skills/prompt-skill-lookup.js';

describe('prompt skill lookup', () => {
  it('matches skills from the user prompt', () => {
    const matches = matchSkillsForPrompt('Please convert this pdf invoice', [
      { name: 'pdf', description: 'Create and edit PDF documents' },
      { name: 'xlsx', description: 'Spreadsheet workbooks' },
    ]);
    expect(matches[0]?.name).toBe('pdf');
  });

  it('boosts mandatory skills and formats reminders', () => {
    const matches = matchSkillsForPrompt(
      'spreadsheet workbook formulas',
      [
        { name: 'xlsx', description: 'Spreadsheet workbooks', disposition: 'mandatory' },
        { name: 'csv', description: 'Spreadsheet exports', disposition: 'optional' },
      ],
      { limit: 2 },
    );
    expect(matches[0]?.name).toBe('xlsx');
    expect(matches[0]?.disposition).toBe('mandatory');
    const text = formatPromptSkillMatchReminder(matches);
    expect(text).toContain('xlsx (mandatory)');
    expect(text).toContain('skill` tool');
  });

  it('returns empty results for stop-word-only prompts', () => {
    expect(tokenizePromptLookupText('the to and of')).toEqual([]);
    expect(matchSkillsForPrompt('the to and of', [{ name: 'pdf' }])).toEqual([]);
    expect(formatPromptSkillMatchReminder([])).toBe('');
  });

  it('drops forbidden skills and stamps mandatory disposition from session policy', () => {
    const candidates = applyPromptSkillSessionPolicy(
      [
        { name: 'pdf', description: 'PDF documents' },
        { name: 'xlsx', description: 'Spreadsheets' },
        { name: 'docx', description: 'Word documents' },
      ],
      {
        closed: false,
        dispositions: { pdf: 'forbidden', xlsx: 'mandatory' },
      },
    );
    expect(candidates.map((candidate) => candidate.name)).toEqual(['xlsx', 'docx']);
    expect(candidates[0]?.disposition).toBe('mandatory');
    const matches = matchSkillsForPrompt('pdf xlsx spreadsheet', candidates);
    expect(matches.map((match) => match.name)).not.toContain('pdf');
    expect(matches[0]?.disposition).toBe('mandatory');
  });

  it('hides unlisted skills when the session catalog is closed', () => {
    const candidates = applyPromptSkillSessionPolicy(
      [
        { name: 'pdf', description: 'PDF documents' },
        { name: 'xlsx', description: 'Spreadsheets' },
      ],
      { closed: true, dispositions: { pdf: 'optional' } },
    );
    expect(candidates.map((candidate) => candidate.name)).toEqual(['pdf']);
  });

  it('respects minScore and limit options', () => {
    const matches = matchSkillsForPrompt(
      'pdf and xlsx documents',
      [
        { name: 'pdf', description: 'pdf files' },
        { name: 'xlsx', description: 'xlsx sheets' },
        { name: 'docx', description: 'word files' },
      ],
      { minScore: 3, limit: 1 },
    );
    expect(matches).toHaveLength(1);
  });
});

describe('prompt memory lookup', () => {
  it('matches memory excerpts from the user prompt', () => {
    const matches = matchMemoryForPrompt('What is my preferred deploy target?', [
      {
        source: 'agent-memory',
        content:
          'Preferred deploy target is staging before production.\n\nUnrelated cooking notes about pasta recipes tonight.',
      },
    ]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.excerpt.toLowerCase()).toContain('deploy');
    expect(formatPromptMemoryLookup(matches)).toContain('[agent-memory]');
  });

  it('ignores short paragraphs and empty prompts', () => {
    expect(matchMemoryForPrompt('the and', [{ source: 'agent-memory', content: 'deploy target staging' }])).toEqual(
      [],
    );
    expect(
      matchMemoryForPrompt('deploy target staging', [
        { source: 'agent-memory', content: 'too short' },
      ]),
    ).toEqual([]);
    expect(formatPromptMemoryLookup([])).toBe('');
  });

  it('truncates long excerpts under the char budget', () => {
    const long =
      'Preferred deploy target is staging before production and also keep a long trailing note. '.repeat(
        20,
      );
    const matches = matchMemoryForPrompt(
      'preferred deploy target staging production',
      [{ source: 'agent-memory', content: long }],
      { maxChars: 120, limit: 1, minScore: 1 },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.excerpt.length).toBeLessThanOrEqual(120);
    expect(matches[0]!.excerpt.endsWith('…')).toBe(true);
  });
});

describe('knowledge proposal store', () => {
  it('supports list filters, cancel, and double-review protection', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-store-'));
    try {
      const store = new KnowledgeProposalStore(dataDir, () => 1_700_000_000_000);
      const skill = await store.create({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_a',
        agentName: 'mavis',
        title: 'Skill A',
        summary: 'summary',
        rationale: 'rationale',
        draft: 'draft-a',
      });
      await store.create({
        kind: 'memory',
        action: 'improve',
        sessionId: 'sess_b',
        agentName: 'mavis',
        title: 'Memory B',
        summary: 'summary',
        rationale: 'rationale',
        draft: 'draft-b',
        targetRef: 'user',
      });
      expect(await store.list({ kind: 'skill' })).toHaveLength(1);
      expect(await store.list({ sessionId: 'sess_b' })).toHaveLength(1);
      expect(await store.get(skill.id)).toMatchObject({ id: skill.id, status: 'pending' });

      const cancelled = await store.cancel(skill.id, 'not needed');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.reviewNote).toBe('not needed');
      await expect(store.cancel(skill.id)).rejects.toBeInstanceOf(KnowledgeProposalError);
      await expect(
        store.review({ proposalId: skill.id, decision: 'approve' }),
      ).rejects.toMatchObject({ code: 'not-pending' });
      await expect(
        store.review({ proposalId: 'missing', decision: 'reject' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses to replace a corrupt store with an empty one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-store-corrupt-'));
    try {
      const store = new KnowledgeProposalStore(dataDir, () => 1_700_000_000_000);
      await store.create({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_a',
        agentName: 'mavis',
        title: 'Skill A',
        summary: 'summary',
        rationale: 'rationale',
        draft: 'draft-a',
      });
      const file = join(dataDir, 'local-runtime', 'knowledge-proposals.json');
      await writeFile(file, '{', 'utf8');
      await expect(store.list()).rejects.toMatchObject({ code: 'corrupt' });
      await expect(
        store.create({
          kind: 'skill',
          action: 'create',
          sessionId: 'sess_a',
          agentName: 'mavis',
          title: 'Skill A',
          summary: 'summary',
          rationale: 'rationale',
          draft: 'draft-a',
        }),
      ).rejects.toMatchObject({ code: 'corrupt' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('knowledge proposal review', () => {
  it('requires human approve before apply and supports reject', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-review-'));
    try {
      let created = 0;
      const review = createKnowledgeReviewApplication({
        dataDir: () => dataDir,
        nowMs: () => 1_700_000_000_000,
        skills: {
          createSkill: async () => {
            created += 1;
            return {
              skill: {
                name: 'session-pattern',
                description: 'desc',
              },
            } as never;
          },
        },
      });
      const proposal = await review.createProposal({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_1',
        agentName: 'mavis',
        title: 'Draft skill',
        summary: 'summary',
        rationale: 'rationale',
        draft: [
          '---',
          'name: session-pattern',
          'description: Reusable session pattern',
          '---',
          '',
          '# Session pattern',
          '',
        ].join('\n'),
      });
      expect(proposal.status).toBe('pending');
      expect(created).toBe(0);

      const rejected = await review.reviewProposal({
        proposalId: proposal.id,
        decision: 'reject',
        reviewNote: 'not useful',
      });
      expect(rejected.proposal.status).toBe('rejected');
      expect(rejected.applied).toBe(false);
      expect(created).toBe(0);

      const second = await review.createProposal({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_1',
        agentName: 'mavis',
        title: 'Draft skill 2',
        summary: 'summary',
        rationale: 'rationale',
        draft: [
          '---',
          'name: session-pattern',
          'description: Reusable session pattern',
          '---',
          '',
          '# Session pattern',
          '',
        ].join('\n'),
      });
      const approved = await review.reviewProposal({
        proposalId: second.id,
        decision: 'approve',
        editedDraft: [
          '---',
          'name: session-pattern',
          'description: Edited description',
          '---',
          '',
          '# Edited',
          '',
        ].join('\n'),
      });
      expect(approved.applied).toBe(true);
      expect(approved.proposal.status).toBe('approved');
      expect(KnowledgeProposalStore.effectiveDraft(approved.proposal)).toContain('Edited description');
      expect(created).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('applies approved memory drafts to agent or user memory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-memory-apply-'));
    try {
      const writes: Array<{ target: string; content: string; reason?: string }> = [];
      const review = createKnowledgeReviewApplication({
        dataDir: () => dataDir,
        nowMs: () => 1_700_000_000_100,
        memory: {
          appendMemory: async (agentName, content) => {
            writes.push({ target: agentName, content });
            return { content, path: 'MEMORY.md' } as never;
          },
          appendUserMemory: async (content, reason) => {
            writes.push({ target: 'user', content, reason });
            return { content, path: 'user.md' } as never;
          },
        },
      });
      const agentProposal = await review.createProposal({
        kind: 'memory',
        action: 'improve',
        sessionId: 'sess_mem',
        agentName: 'mavis',
        title: 'Agent memory',
        summary: 'summary',
        rationale: 'keep this',
        draft: 'agent durable note',
        targetRef: 'agent-main',
      });
      const userProposal = await review.createProposal({
        kind: 'memory',
        action: 'improve',
        sessionId: 'sess_mem',
        agentName: 'mavis',
        title: 'User memory',
        summary: 'summary',
        rationale: 'user preference',
        draft: 'user durable note',
        targetRef: 'user',
      });
      await review.reviewProposal({ proposalId: agentProposal.id, decision: 'approve' });
      await review.reviewProposal({ proposalId: userProposal.id, decision: 'approve' });
      expect(writes).toEqual([
        { target: 'mavis', content: 'agent durable note' },
        { target: 'user', content: 'user durable note', reason: 'user preference' },
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('parses skill drafts without frontmatter on approve', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-skill-plain-'));
    try {
      let createdName = '';
      const review = createKnowledgeReviewApplication({
        dataDir: () => dataDir,
        skills: {
          createSkill: async (input) => {
            createdName = input.name;
            return { skill: { name: input.name, description: input.description } } as never;
          },
        },
      });
      const proposal = await review.createProposal({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_plain',
        agentName: 'mavis',
        title: 'Plain Draft Skill',
        summary: 'summary',
        rationale: 'rationale',
        draft: '# Plain body only\n\nSteps go here.\n',
      });
      await review.reviewProposal({ proposalId: proposal.id, decision: 'approve' });
      expect(createdName).toBe('plain-draft-skill');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves the proposal pending when apply fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-apply-fail-'));
    try {
      const review = createKnowledgeReviewApplication({
        dataDir: () => dataDir,
        skills: {
          createSkill: async () => {
            throw new Error('disk full');
          },
        },
      });
      const proposal = await review.createProposal({
        kind: 'skill',
        action: 'create',
        sessionId: 'sess_fail',
        agentName: 'mavis',
        title: 'Failing skill',
        summary: 'summary',
        rationale: 'rationale',
        draft: 'body',
      });
      await expect(
        review.reviewProposal({ proposalId: proposal.id, decision: 'approve' }),
      ).rejects.toThrow(/disk full/);
      expect(await review.getProposal(proposal.id)).toMatchObject({ status: 'pending' });

      const unavailable = createKnowledgeReviewApplication({ dataDir: () => dataDir });
      const memory = await unavailable.createProposal({
        kind: 'memory',
        action: 'improve',
        sessionId: 'sess_fail',
        agentName: 'mavis',
        title: 'Memory',
        summary: 'summary',
        rationale: 'rationale',
        draft: 'note',
      });
      await expect(
        unavailable.reviewProposal({ proposalId: memory.id, decision: 'approve' }),
      ).rejects.toMatchObject({ code: 'apply-unavailable' });
      expect(await unavailable.getProposal(memory.id)).toMatchObject({ status: 'pending' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('idle knowledge proposals', () => {
  it('creates idle skill and memory drafts for human review', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-idle-'));
    try {
      const store = new KnowledgeProposalStore(dataDir, () => 1_700_000_000_000);
      const result = await createIdleKnowledgeProposals(
        {
          sessionId: 'sess_idle',
          agentName: 'mavis',
          title: 'Deploy website rollout',
          messageCount: 12,
          recentUserTexts: [
            'deploy the website to staging',
            'check website deploy logs',
            'website deploy failed again',
          ],
        },
        { store },
      );
      expect(result.created).toBe(2);
      const pending = await store.list({ status: 'pending' });
      expect(pending.map((item) => item.kind).sort()).toEqual(['memory', 'skill']);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('skips when disabled, under message threshold, or already pending', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'knowledge-idle-skip-'));
    try {
      const store = new KnowledgeProposalStore(dataDir, () => 1_700_000_000_000);
      const session = {
        sessionId: 'sess_skip',
        agentName: 'mavis',
        title: 'Deploy website',
        messageCount: 12,
        recentUserTexts: ['deploy website staging', 'deploy website again'],
      };
      expect(await createIdleKnowledgeProposals(session, { store, enabled: false })).toEqual({
        created: 0,
        proposalIds: [],
      });
      expect(
        await createIdleKnowledgeProposals(
          { ...session, messageCount: 2 },
          { store, minMessageCount: 8 },
        ),
      ).toEqual({ created: 0, proposalIds: [] });
      const first = await createIdleKnowledgeProposals(session, { store });
      expect(first.created).toBe(2);
      const second = await createIdleKnowledgeProposals(session, { store });
      expect(second).toEqual({ created: 0, proposalIds: [] });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
