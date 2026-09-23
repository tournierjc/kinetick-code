import type { V1SessionCompatibility } from "../compat/v1/session.js";
import type { InitializedSessionApplicationSystem } from "../service/session-system/index.js";
import type { TurnService } from "../service/turn-system/index.js";
import type { LocalAttachmentRegistrationPort } from "./conversation/attachment-registration.js";
import { QueueApplication } from "./queue/queue-application.js";
import { SessionContentApplication } from "./session/content-application.js";
import { SessionDiffApplication } from "./session/diff-application.js";
import {
  SessionLifecycleApplication,
  type SessionLifecycleApplicationOptions,
} from "./session/lifecycle-application.js";
import { SessionQueryApplication } from "./session/query-application.js";
import {
  SessionRootApplication,
  SessionRootEventProjector,
  type SessionRootApplicationOptions,
} from "./session/root-application.js";
import type { GlobalEventPublisher } from "./events.js";
import type { ApplicationMetricsClient } from "./session/metrics.js";
import {
  SessionConversationMutationApplication,
  type ConversationMutationPort,
  type ConversationMutationWorkflow,
} from "./session/conversation-mutation-application.js";
import { SessionPinApplication } from "./session/pin-application.js";
import type { SessionPinApplicationOptions } from "./session/pin-application.js";
import type { PinService } from "../service/pin/index.js";

export interface RuntimeApplications {
  readonly session: {
    readonly query: SessionQueryApplication;
    readonly content: SessionContentApplication;
    readonly lifecycle: SessionLifecycleApplication;
    readonly root: SessionRootApplication;
    readonly diff: SessionDiffApplication;
    readonly conversationMutation: SessionConversationMutationApplication;
    readonly pin: SessionPinApplication;
  };
  readonly queue: QueueApplication;
}

export interface InitializeApplicationsOptions {
  readonly sessionSystem: InitializedSessionApplicationSystem;
  readonly compatibility: V1SessionCompatibility;
  readonly attachmentRegistration: LocalAttachmentRegistrationPort;
  readonly resolveAgentWriteTarget: (requestRef: string) => Promise<string>;
  readonly requireExactAgentKey: SessionRootApplicationOptions["requireExactAgentKey"];
  readonly turn: SessionRootApplicationOptions["turn"] & {
    sessionDeletion(
      sessionId: string,
      cleanup: () => Promise<void>,
    ): Promise<void>;
    submit: TurnService["submit"];
  };
  readonly publishGlobalEvent: GlobalEventPublisher;
  /** Ordered pin list owner; Session pins are a preference value, not a column. */
  readonly pin: SessionPinApplicationOptions["pinService"] & Pick<PinService, "getOrder">;
  readonly metrics?: ApplicationMetricsClient;
  readonly onRootBestEffortFailure?: SessionRootApplicationOptions["onBestEffortFailure"];
  readonly assertSessionDeletionAllowed?: (sessionId: string) => Promise<void>;
  readonly nowMs?: () => number;
  readonly runPluginHookSessionEndFence?: SessionLifecycleApplicationOptions["runPluginHookSessionEndFence"];
  readonly preparePluginHookSessionEnd?: (
    sessionId: string,
    reason: "archive",
  ) => Promise<void>;
  readonly endPluginHookSession?: (
    sessionId: string,
    reason: "archive",
  ) => Promise<void>;
  readonly conversationMutationPort: ConversationMutationPort;
  readonly conversationMutationWorkflow?: ConversationMutationWorkflow;
}

export type InitializeApplications = (
  options: InitializeApplicationsOptions,
) => RuntimeApplications;

/**
 * Session ids from the ordered pin list, most recently pinned first as the list keeps
 * them. Read on demand so a pin written by another process is picked up by the next
 * catalogue read.
 */
async function readPinnedSessionIds(pin: Pick<PinService, "getOrder">): Promise<readonly string[]> {
  const items = await pin.getOrder();
  return items.filter((item) => item.ref.type === "session").map((item) => item.ref.id);
}

/** Constructs named feature applications without adding an aggregate forwarding facade. */
export const initializeApplications: InitializeApplications = (options) => {
  const root = new SessionRootApplication({
    invariant: options.sessionSystem.root.invariant,
    resolveAgentWriteTarget: options.resolveAgentWriteTarget,
    requireExactAgentKey: options.requireExactAgentKey,
    turn: options.turn,
    archiveTitle: options.sessionSystem.root.archiveTitle,
    facts: new SessionRootEventProjector({
      publish: options.publishGlobalEvent,
    }),
    ...(options.onRootBestEffortFailure
      ? { onBestEffortFailure: options.onRootBestEffortFailure }
      : {}),
  });
  const deletion = options.sessionSystem.session.deletion.create();
  const createSideSession =
    options.conversationMutationWorkflow?.createSideSession;
  const lifecycle = new SessionLifecycleApplication({
    lifecycle: options.sessionSystem.session.lifecycle,
    ...(createSideSession
      ? {
          sideFork: {
            create: (
              input: Parameters<NonNullable<typeof createSideSession>>[0],
            ) => createSideSession(input),
          },
        }
      : {}),
    resolveAgentWriteTarget: options.resolveAgentWriteTarget,
    ...(options.runPluginHookSessionEndFence
      ? { runPluginHookSessionEndFence: options.runPluginHookSessionEndFence }
      : {}),
    ...(options.preparePluginHookSessionEnd
      ? { preparePluginHookSessionEnd: options.preparePluginHookSessionEnd }
      : {}),
    ...(options.endPluginHookSession
      ? { endPluginHookSession: options.endPluginHookSession }
      : {}),
    deletion: {
      deleteSession: (sessionId) =>
        options.turn.sessionDeletion(sessionId, async () => {
          await deletion.deleteSession(sessionId);
        }),
    },
    ...(options.assertSessionDeletionAllowed
      ? { assertSessionDeletionAllowed: options.assertSessionDeletionAllowed }
      : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
  const query = new SessionQueryApplication({
    service: options.sessionSystem.session.query,
    pinnedSessions: () => readPinnedSessionIds(options.pin),
  });
  const content = new SessionContentApplication({
    messages: options.sessionSystem.messages.query,
    sources: options.sessionSystem.messages.sources,
    maintenance: options.sessionSystem.session.maintenance,
    staleCompactionRepair: options.sessionSystem.messages.staleCompactionRepair,
    files: options.sessionSystem.files,
    inputSummaries: options.sessionSystem.messages.inputSummaries,
    usage: options.sessionSystem.usage,
    peekContext: options.sessionSystem.messages.peekContext,
    queryCollapse: options.sessionSystem.queryCollapse,
    conversationActions: options.sessionSystem.messages.conversationActions,
    conversationMutation: options.conversationMutationPort,
    forkOriginSessions: options.sessionSystem.repositories.sessions,
  });
  const diff = new SessionDiffApplication({
    service: options.sessionSystem.diff,
    capability: options.compatibility.diff.capability,
  });
  const queue = new QueueApplication({
    queue: options.sessionSystem.queue.committed,
    attachmentRegistration: options.attachmentRegistration,
  });
  const conversationMutation = new SessionConversationMutationApplication(
    options.conversationMutationPort,
    options.conversationMutationWorkflow,
  );
  const pin = new SessionPinApplication({
    pinService: options.pin,
    publish: options.publishGlobalEvent,
  });
  return {
    session: { query, content, lifecycle, root, diff, conversationMutation, pin },
    queue,
  };
};
