import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIdleKnowledgeProposals } from '../../src/knowledge/idle-proposals.js';
import { KnowledgeProposalStore } from '../../src/knowledge/proposal-store.js';
import { createKnowledgeReviewApplication } from '../../src/knowledge/review-application.js';
import { matchSkillsForPrompt } from '../../src/skills/prompt-skill-lookup.js';
import { matchMemoryForPrompt } from '../../src/memory/prompt-memory-lookup.js';

describe('prompt skill and memory lookup', () => {
  it('matches skills from the user prompt', () => {
    const matches = matchSkillsForPrompt('Please convert this pdf invoice', [
      { name: 'pdf', description: 'Create and edit PDF documents' },
      { name: 'xlsx', description: 'Spreadsheet workbooks' },
    ]);
    expect(matches[0]?.name).toBe('pdf');
  });

  it('matches memory excerpts from the user prompt', () => {
    const matches = matchMemoryForPrompt(
      'What is my preferred deploy target?',
      [
        {
          source: 'agent-memory',
          content:
            'Preferred deploy target is staging before production.\n\nUnrelated cooking notes about pasta.',
        },
      ],
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.excerpt.toLowerCase()).toContain('deploy');
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
      expect(created).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

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
});
