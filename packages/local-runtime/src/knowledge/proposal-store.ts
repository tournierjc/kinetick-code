/**
 * Knowledge proposal store for Skill and Memory create/improve drafts.
 *
 * Idle reflection and agent-reported proposals land here as `pending`. A human
 * must approve (optionally after editing) or reject before any change is
 * applied to Skill files or Memory. Approving records `approved` and returns
 * the payload for the caller to apply; this store never mutates Skills/Memory
 * itself.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type KnowledgeProposalKind = 'skill' | 'memory';
export type KnowledgeProposalAction = 'create' | 'improve';
export type KnowledgeProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface KnowledgeProposal {
  readonly id: string;
  readonly kind: KnowledgeProposalKind;
  readonly action: KnowledgeProposalAction;
  readonly status: KnowledgeProposalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string;
  readonly summary: string;
  readonly rationale: string;
  readonly draft: string;
  readonly targetRef?: string;
  readonly evidenceExcerpts: readonly string[];
  readonly editedDraft?: string;
  readonly reviewNote?: string;
  readonly reviewedAt?: number;
}

export interface CreateKnowledgeProposalInput {
  readonly kind: KnowledgeProposalKind;
  readonly action: KnowledgeProposalAction;
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string;
  readonly summary: string;
  readonly rationale: string;
  readonly draft: string;
  readonly targetRef?: string;
  readonly evidenceExcerpts?: readonly string[];
}

export interface ReviewKnowledgeProposalInput {
  readonly proposalId: string;
  readonly decision: 'approve' | 'reject';
  /** Optional edited draft applied only when approving. */
  readonly editedDraft?: string;
  readonly reviewNote?: string;
}

interface KnowledgeProposalState {
  proposals: KnowledgeProposal[];
}

export class KnowledgeProposalStore {
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.file = join(dataDir, 'local-runtime', 'knowledge-proposals.json');
  }

  async create(input: CreateKnowledgeProposalInput): Promise<KnowledgeProposal> {
    const state = await this.read();
    const now = this.nowMs();
    const proposal: KnowledgeProposal = {
      id: `kp_${randomBytes(6).toString('hex')}`,
      kind: input.kind,
      action: input.action,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      sessionId: input.sessionId.trim() || 'unknown',
      agentName: input.agentName.trim() || 'unknown',
      title: input.title.trim(),
      summary: input.summary.trim(),
      rationale: input.rationale.trim(),
      draft: input.draft,
      ...(input.targetRef?.trim() ? { targetRef: input.targetRef.trim() } : {}),
      evidenceExcerpts: [...(input.evidenceExcerpts ?? [])].map((item) => item.trim()).filter(Boolean),
    };
    state.proposals.unshift(proposal);
    await this.write(state);
    return proposal;
  }

  async list(filter: {
    readonly status?: KnowledgeProposalStatus;
    readonly kind?: KnowledgeProposalKind;
    readonly sessionId?: string;
    readonly limit?: number;
  } = {}): Promise<KnowledgeProposal[]> {
    const state = await this.read();
    const limit = clampInt(filter.limit, 50, 1, 200);
    return state.proposals
      .filter((proposal) => (filter.status ? proposal.status === filter.status : true))
      .filter((proposal) => (filter.kind ? proposal.kind === filter.kind : true))
      .filter((proposal) =>
        filter.sessionId ? proposal.sessionId === filter.sessionId : true,
      )
      .slice(0, limit);
  }

  async get(proposalId: string): Promise<KnowledgeProposal | undefined> {
    const state = await this.read();
    return state.proposals.find((proposal) => proposal.id === proposalId);
  }

  async review(input: ReviewKnowledgeProposalInput): Promise<KnowledgeProposal> {
    const state = await this.read();
    const proposal = state.proposals.find((item) => item.id === input.proposalId);
    if (!proposal) {
      throw new KnowledgeProposalError('not-found', `Proposal ${input.proposalId} not found`);
    }
    if (proposal.status !== 'pending') {
      throw new KnowledgeProposalError(
        'not-pending',
        `Proposal ${input.proposalId} is ${proposal.status}`,
      );
    }
    const now = this.nowMs();
    const next: KnowledgeProposal = {
      ...proposal,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      updatedAt: now,
      reviewedAt: now,
      ...(input.editedDraft !== undefined ? { editedDraft: input.editedDraft } : {}),
      ...(input.reviewNote?.trim() ? { reviewNote: input.reviewNote.trim() } : {}),
    };
    state.proposals = state.proposals.map((item) => (item.id === proposal.id ? next : item));
    await this.write(state);
    return next;
  }

  async cancel(proposalId: string, reason?: string): Promise<KnowledgeProposal> {
    const state = await this.read();
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal) {
      throw new KnowledgeProposalError('not-found', `Proposal ${proposalId} not found`);
    }
    if (proposal.status !== 'pending') {
      throw new KnowledgeProposalError(
        'not-pending',
        `Proposal ${proposalId} is ${proposal.status}`,
      );
    }
    const now = this.nowMs();
    const next: KnowledgeProposal = {
      ...proposal,
      status: 'cancelled',
      updatedAt: now,
      reviewedAt: now,
      ...(reason?.trim() ? { reviewNote: reason.trim() } : {}),
    };
    state.proposals = state.proposals.map((item) => (item.id === proposal.id ? next : item));
    await this.write(state);
    return next;
  }

  /** Effective draft text after human edit, if any. */
  static effectiveDraft(proposal: KnowledgeProposal): string {
    return proposal.editedDraft ?? proposal.draft;
  }

  private async read(): Promise<KnowledgeProposalState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as Partial<KnowledgeProposalState>;
      return {
        proposals: Array.isArray(parsed.proposals)
          ? parsed.proposals.filter(isKnowledgeProposal)
          : [],
      };
    } catch {
      return { proposals: [] };
    }
  }

  private async write(state: KnowledgeProposalState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }
}

export class KnowledgeProposalError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-pending',
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeProposalError';
  }
}

function isKnowledgeProposal(value: unknown): value is KnowledgeProposal {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    (record.kind === 'skill' || record.kind === 'memory') &&
    (record.action === 'create' || record.action === 'improve') &&
    typeof record.status === 'string' &&
    typeof record.title === 'string' &&
    typeof record.draft === 'string'
  );
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : raw;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
