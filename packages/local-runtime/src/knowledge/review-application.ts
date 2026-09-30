/**
 * Knowledge proposal review application. Idle drafts and agent-reported
 * Skill/Memory proposals stay pending until a human approves (optionally after
 * editing) or rejects them. Approve applies the effective draft; reject only
 * records the decision.
 */

import {
  KnowledgeProposalError,
  KnowledgeProposalStore,
  type CreateKnowledgeProposalInput,
  type KnowledgeProposal,
  type KnowledgeProposalKind,
  type KnowledgeProposalStatus,
  type ReviewKnowledgeProposalInput,
} from './proposal-store.js';
import { createIdleKnowledgeProposals } from './idle-proposals.js';
import type { LocalMemoryFacade } from '../memory/local-memory-facade.js';
import type { LocalSkillService } from '../skills/skill-service.js';

export interface KnowledgeReviewApplicationOptions {
  readonly dataDir: () => string;
  readonly nowMs?: () => number;
  readonly skills?: Pick<LocalSkillService, 'createSkill'>;
  readonly memory?: Pick<LocalMemoryFacade, 'appendMemory' | 'appendUserMemory'>;
  readonly minIdleMessageCount?: number;
}

export class KnowledgeReviewApplication {
  private readonly nowMs: () => number;

  constructor(private readonly options: KnowledgeReviewApplicationOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  private store(): KnowledgeProposalStore {
    return new KnowledgeProposalStore(this.options.dataDir(), this.nowMs);
  }

  createProposal(input: CreateKnowledgeProposalInput): Promise<KnowledgeProposal> {
    return this.store().create(input);
  }

  listProposals(filter: {
    readonly status?: KnowledgeProposalStatus;
    readonly kind?: KnowledgeProposalKind;
    readonly sessionId?: string;
    readonly limit?: number;
  } = {}): Promise<KnowledgeProposal[]> {
    return this.store().list(filter);
  }

  getProposal(proposalId: string): Promise<KnowledgeProposal | undefined> {
    return this.store().get(proposalId);
  }

  async reviewProposal(
    input: ReviewKnowledgeProposalInput,
  ): Promise<{ proposal: KnowledgeProposal; applied: boolean }> {
    const store = this.store();
    const proposal = await store.review(input);
    if (input.decision !== 'approve') {
      return { proposal, applied: false };
    }
    const draft = KnowledgeProposalStore.effectiveDraft(proposal);
    if (proposal.kind === 'skill') {
      await this.applySkillProposal(proposal, draft);
    } else {
      await this.applyMemoryProposal(proposal, draft);
    }
    return { proposal, applied: true };
  }

  cancelProposal(proposalId: string, reason?: string): Promise<KnowledgeProposal> {
    return this.store().cancel(proposalId, reason);
  }

  async onSessionIdle(input: {
    readonly sessionId: string;
    readonly agentName: string;
    readonly title?: string;
    readonly messageCount: number;
    readonly recentUserTexts: readonly string[];
    readonly enabled?: boolean;
  }): Promise<{ readonly created: number; readonly proposalIds: readonly string[] }> {
    return createIdleKnowledgeProposals(
      {
        sessionId: input.sessionId,
        agentName: input.agentName,
        ...(input.title ? { title: input.title } : {}),
        messageCount: input.messageCount,
        recentUserTexts: input.recentUserTexts,
      },
      {
        store: this.store(),
        ...(this.options.minIdleMessageCount === undefined
          ? {}
          : { minMessageCount: this.options.minIdleMessageCount }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    );
  }

  private async applySkillProposal(proposal: KnowledgeProposal, draft: string): Promise<void> {
    if (!this.options.skills) {
      throw new KnowledgeProposalError(
        'not-pending',
        'Skill apply is unavailable in this host',
      );
    }
    const parsed = parseSkillDraft(draft, proposal.title);
    await this.options.skills.createSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      agentName: proposal.agentName,
    });
  }

  private async applyMemoryProposal(proposal: KnowledgeProposal, draft: string): Promise<void> {
    if (!this.options.memory) {
      throw new KnowledgeProposalError(
        'not-pending',
        'Memory apply is unavailable in this host',
      );
    }
    if (proposal.targetRef === 'user') {
      await this.options.memory.appendUserMemory(
        draft,
        proposal.rationale || 'Approved knowledge proposal',
      );
      return;
    }
    await this.options.memory.appendMemory(proposal.agentName, draft);
  }
}

export function createKnowledgeReviewApplication(
  options: KnowledgeReviewApplicationOptions,
): KnowledgeReviewApplication {
  return new KnowledgeReviewApplication(options);
}

function parseSkillDraft(
  draft: string,
  fallbackTitle: string,
): { name: string; description: string; content: string } {
  const match = draft.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if (!match) {
    return {
      name: slugify(fallbackTitle),
      description: fallbackTitle,
      content: draft,
    };
  }
  const frontmatter = match[1] ?? '';
  const body = (match[2] ?? '').trimStart();
  const name =
    frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim() || slugify(fallbackTitle);
  const description =
    frontmatter.match(/^description:\s*(.+)$/mu)?.[1]?.trim() || fallbackTitle;
  return { name, description, content: body || draft };
}

function slugify(value: string): string {
  const slug = value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return slug || 'knowledge-skill';
}
