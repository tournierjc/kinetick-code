import type { TuiRuntime } from '../runtime/port.js';

/**
 * Runtime capabilities consumed by the session server.
 *
 * The server surface is capability-optional: every method beyond the core
 * read path (`listSessionPage` / `getSession` / `listMessagePage`) is
 * optional, and the HTTP layer answers 404 for endpoints whose capability the
 * active Runtime does not expose. The full adapter satisfies this shape, so
 * `--server` gets the complete surface without casting.
 */
export type TuiServerRuntime = Pick<
  TuiRuntime,
  // Core read path (required).
  'listSessionPage' | 'getSession' | 'listMessagePage'
> &
  Partial<
    Pick<
      TuiRuntime,
      // Session catalogue mutations.
      | 'createSession'
      | 'renameSession'
      | 'archiveSession'
      | 'pinSession'
      | 'deleteSession'
      | 'getSessionRewindPreview'
      | 'rewindSession'
      | 'editSessionMessage'
      // Conversation.
      | 'sendMessage'
      | 'abortSession'
      | 'steer'
      | 'watchSessionTurn'
      // Interactions (user input needed).
      | 'getPendingQuestionnaire'
      | 'getLatestPlanReview'
      | 'replyQuestionnaire'
      | 'dismissQuestionnaire'
      | 'listPendingPermissions'
      | 'replyPermission'
      // Events.
      | 'watchEvents'
      // Runs, delegation, background tasks.
      | 'getActiveRun'
      | 'getDelegationSnapshot'
      | 'stopDelegation'
      | 'listBackgroundTasks'
      // Queue.
      | 'getQueueSnapshot'
      | 'continueQueue'
      | 'listQueuedMessages'
      | 'steerQueuedMessage'
      | 'enqueueMessage'
      | 'updateQueuedMessageContent'
      | 'deleteQueuedMessage'
      // Inspection (skills, MCP, usage, context).
      | 'getSessionUsage'
      | 'requestCompaction'
      | 'listSkills'
      | 'listMcpServers'
      | 'getContextSnapshot'
      // Configuration (models, permission mode, diagnostics, account).
      | 'getRuntimeDiagnostics'
      | 'getAccountStatus'
      | 'getPermissionMode'
      | 'setPermissionMode'
      | 'listModels'
      | 'selectModel'
      | 'selectSessionModel'
      // Goals.
      | 'getGoal'
      | 'createGoal'
      | 'patchGoal'
      | 'clearGoal'
      // Fork (Partial on the product boundary).
      | 'forkSession'
      | 'getSessionForkOptions'
    >
  >;
