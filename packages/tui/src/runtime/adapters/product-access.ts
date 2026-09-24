import { isLegacyManagedMinimaxProvider } from "@mavis/config";
import {
  normalizeTuiPermissionMode,
  type TuiPermissionMode,
} from "../../application/permission-mode.js";
import type {
  TuiAccountStatus,
  TuiAccountStatusOptions,
  TuiActiveRunSnapshot,
  TuiCompactionResult,
  TuiContextSnapshotResponse,
  TuiInstructionSource,
  TuiMcpServer,
  TuiProjectMcpPreview,
  TuiModel,
  TuiModelSelection,
  TuiRuntimeDiagnostics,
  TuiSession,
  TuiSessionUsage,
  TuiSessionUsageSummary,
  TuiSkillList,
} from "../port.js";
import type { TuiRuntimeAccessContext } from "./access-context.js";
import type { TuiSessionAccess } from "./session-access.js";
import type {
  KcodeCreateProviderInput,
  KcodeCopilotOAuthStatus,
  KcodeCodexOAuthStartResult,
  KcodeCodexOAuthLoginOptions,
  KcodeCodexOAuthStatus,
  KcodeMiniMaxModelSource,
  KcodeProviderTemplate,
  KcodeProviderTestResult,
  KcodeRuntimeProviderView,
  KcodeSaveProviderCandidateInput,
  KcodeSaveProviderCandidateResult,
  KcodeUpdateProviderInput,
} from "../../provider/contract.js";
import {
  normalizeAccountStatus,
  normalizeRuntimeDiagnostics,
} from "./normalizers.js";
import { projectTuiContextSnapshot } from "../projections/context-snapshot.js";

export class TuiProductAccess {
  constructor(
    private readonly context: TuiRuntimeAccessContext,
    private readonly defaultAgentName: string,
    private readonly workspaceDir?: string,
    /** Session-tree reader owned by the session access adapter (shared instance). */
    private readonly sessionTree?: Pick<
      TuiSessionAccess,
      'getSessionTree'
    >,
  ) {}

  async getAccountStatus(
    sessionId?: string,
    options?: TuiAccountStatusOptions,
  ): Promise<TuiAccountStatus> {
    return normalizeAccountStatus(
      await this.context.service("runtime.account").getAccountStatus({
        ...(sessionId ? { sessionId } : {}),
        ...(options?.model
          ? { model: `${options.model.providerId}/${options.model.modelId}` }
          : {}),
      }),
    );
  }

  async getRuntimeDiagnostics(): Promise<TuiRuntimeDiagnostics> {
    return normalizeRuntimeDiagnostics(
      await this.context.service("runtime.diagnostics").getRuntimeDiagnostics(),
    );
  }

  getInstructionSources(
    workspaceDir: string,
  ): Promise<readonly TuiInstructionSource[]> {
    return this.context
      .service("runtime.instructions")
      .getInstructionSources({ workspaceDir });
  }

  async getPermissionMode(): Promise<TuiPermissionMode | undefined> {
    return normalizeTuiPermissionMode(
      await this.context.service("config.permission.read").getPermissionMode(),
    );
  }

  async setPermissionMode(mode: TuiPermissionMode): Promise<TuiPermissionMode> {
    return (
      normalizeTuiPermissionMode(
        await this.context
          .service("config.permission.write")
          .setPermissionMode({ mode }),
      ) ?? mode
    );
  }

  async listModels(sessionId?: string): Promise<TuiModel[]> {
    const service = this.context.service("model.list");
    const request = { ...(sessionId ? { sessionId } : {}) };
    return (await service.listModels(request)).map(projectTuiModelCatalogEntry);
  }

  async selectModel(
    model: TuiModelSelection,
    sessionId?: string,
  ): Promise<boolean> {
    const service = this.context.service("model.select");
    const request = modelRequest(model);
    if (!sessionId) return service.selectModel(request);

    const savedAsDefault = await service.selectModel(request);
    if (!savedAsDefault) return false;
    return this.selectSessionModel(model, sessionId);
  }

  setModelFavorite(
    model: TuiModelSelection,
    favorite: boolean,
  ): Promise<boolean> {
    return this.context.service("model.favorite").setModelFavorite({
      providerId: model.providerId,
      modelId: model.modelId,
      favorite,
    });
  }

  selectSessionModel(
    model: TuiModelSelection,
    sessionId: string,
  ): Promise<boolean> {
    return this.context.service("model.select").selectModel({
      ...modelRequest(model),
      sessionId,
    });
  }

  async listModelProviders(): Promise<readonly KcodeRuntimeProviderView[]> {
    const providers = (await this.context
      .service("provider.list")
      .listModelProviders()) as unknown as readonly KcodeRuntimeProviderView[];
    return providers.filter(
      (provider) =>
        !isLegacyManagedMinimaxProvider(provider.providerId, provider.baseUrl),
    );
  }

  async listProviderPresets(): Promise<readonly KcodeProviderTemplate[]> {
    return (await this.context
      .service("provider.presets")
      .listProviderPresets()) as readonly KcodeProviderTemplate[];
  }

  async getCodexOAuthStatus(): Promise<KcodeCodexOAuthStatus> {
    return (await this.context
      .service("provider.codex-oauth.status")
      .getCodexOAuthStatus()) as KcodeCodexOAuthStatus;
  }

  async startCodexOAuthLogin(
    options?: KcodeCodexOAuthLoginOptions,
  ): Promise<KcodeCodexOAuthStartResult> {
    return (await this.context
      .service("provider.codex-oauth.start")
      .startCodexOAuthLogin(options)) as KcodeCodexOAuthStartResult;
  }

  async cancelCodexOAuthLogin(loginId: string): Promise<KcodeCodexOAuthStatus> {
    return (await this.context
      .service("provider.codex-oauth.cancel")
      .cancelCodexOAuthLogin(loginId)) as KcodeCodexOAuthStatus;
  }

  async getCopilotOAuthStatus(): Promise<KcodeCopilotOAuthStatus> {
    return (await this.context
      .service("provider.copilot-oauth.status")
      .getCopilotOAuthStatus()) as KcodeCopilotOAuthStatus;
  }

  async startCopilotOAuthLogin(): Promise<KcodeCopilotOAuthStatus> {
    return (await this.context
      .service("provider.copilot-oauth.start")
      .startCopilotOAuthLogin()) as KcodeCopilotOAuthStatus;
  }

  async cancelCopilotOAuthLogin(loginId: string): Promise<KcodeCopilotOAuthStatus> {
    return (await this.context
      .service("provider.copilot-oauth.cancel")
      .cancelCopilotOAuthLogin(loginId)) as KcodeCopilotOAuthStatus;
  }

  async getMiniMaxApiKeyStatus(): Promise<{
    readonly hasApiKey: boolean;
    readonly maskedApiKey?: string;
    readonly cachedStatus?: KcodeProviderTestResult["status"];
  }> {
    return (await this.context
      .service("provider.minimax.status")
      .getMiniMaxApiKeyStatus()) as {
      hasApiKey: boolean;
      maskedApiKey?: string;
      cachedStatus?: KcodeProviderTestResult["status"];
    };
  }

  getMiniMaxModelSource(): Promise<KcodeMiniMaxModelSource> {
    return this.context
      .service("provider.minimax.source")
      .getMiniMaxModelSource();
  }

  setMiniMaxModelSource(
    source: KcodeMiniMaxModelSource,
  ): Promise<KcodeMiniMaxModelSource> {
    return this.context
      .service("provider.minimax.source")
      .setMiniMaxModelSource({ source });
  }

  async upsertMiniMaxApiKey(input: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<void> {
    await this.context
      .service("provider.minimax.upsert")
      .upsertMiniMaxApiKey(input);
  }

  async createUserModelProvider(
    input: KcodeCreateProviderInput,
  ): Promise<void> {
    await this.context.service("provider.create").createUserModelProvider({
      ...input,
      models: [...input.models],
    });
  }

  discoverUserModelsCandidate(
    input: import("../../provider/contract.js").KcodeDiscoverProviderModelsInput,
  ) {
    return this.context
      .service("provider.discover")
      .discoverUserModelsCandidate(input);
  }

  async saveUserModelProviderCandidate({
    modelId,
    saveAndUse,
    skipConnectionTest,
    ...candidate
  }: KcodeSaveProviderCandidateInput): Promise<KcodeSaveProviderCandidateResult> {
    return (await this.context
      .service("provider.save-candidate")
      .saveUserModelProviderCandidate({
        candidate: {
          ...candidate,
          ...(candidate.models
            ? { models: candidate.models.map((model) => ({ ...model })) }
            : {}),
        },
        modelId,
        ...(skipConnectionTest !== undefined ? { skipConnectionTest } : {}),
        ...(saveAndUse !== undefined ? { saveAndUse } : {}),
      })) as KcodeSaveProviderCandidateResult;
  }

  async updateUserModelProvider(
    input: KcodeUpdateProviderInput,
  ): Promise<void> {
    await this.context.service("provider.update").updateUserModelProvider({
      ...input,
      ...(input.models ? { models: [...input.models] } : {}),
    });
  }

  async deleteUserModelProvider(providerId: string): Promise<void> {
    await this.context
      .service("provider.delete")
      .deleteUserModelProvider({ providerId });
  }

  async testUserModelProvider(
    providerId: string,
  ): Promise<KcodeProviderTestResult> {
    return (await this.context
      .service("provider.test")
      .testUserModelProvider({ providerId })) as KcodeProviderTestResult;
  }

  async testUserModel(
    providerId: string,
    modelId: string,
  ): Promise<KcodeProviderTestResult> {
    return (await this.context
      .service("provider.test-model")
      .testUserModel({ providerId, modelId })) as KcodeProviderTestResult;
  }

  async getSessionUsage(sessionId: string): Promise<TuiSessionUsage> {
    const response = await this.context
      .service("session.usage")
      .getSessionUsage({ id: sessionId });
    return {
      summary: response.summary,
      rows: response.rows,
    } as TuiSessionUsage;
  }

  async getSessionUsageSummary(
    sessionId: string,
  ): Promise<TuiSessionUsageSummary> {
    return (await this.context
      .service("session.usage-summary")
      .getSessionUsageSummary({ id: sessionId })) as TuiSessionUsageSummary;
  }

  async getSessionUsageWithRows(sessionId: string): Promise<TuiSessionUsage> {
    const response = await this.context
      .service("session.usage")
      .getSessionUsage({ id: sessionId });
    return {
      ...(response.summary ? { summary: response.summary } : {}),
      ...(Array.isArray(response.rows) ? { rows: response.rows } : {}),
    } as TuiSessionUsage;
  }

  async getSessionTree(agentName?: string): Promise<readonly TuiSession[]> {
    return await (this.sessionTree?.getSessionTree(
      agentName ?? this.defaultAgentName,
    ) ?? Promise.resolve([]));
  }

  async requestCompaction(
    sessionId: string,
    agentName = this.defaultAgentName,
    customInstructions?: string,
  ): Promise<TuiCompactionResult> {
    const response = await this.context
      .service("session.compaction")
      .requestCompaction({
        name: agentName,
        id: sessionId,
        reason: "ui_request",
        ...(customInstructions ? { customInstructions } : {}),
      });
    return {
      ...response,
      ...(response.tokensBefore !== undefined
        ? { tokensBefore: Number(response.tokensBefore) }
        : {}),
      ...(response.tokensAfter !== undefined
        ? { tokensAfter: Number(response.tokensAfter) }
        : {}),
    };
  }

  async getContextSnapshot(
    sessionId: string,
  ): Promise<TuiContextSnapshotResponse> {
    const service = this.context.service("session.context-snapshot");
    const [sessionResponse, messagesResponse, models] = await Promise.all([
      service.getSession({ id: sessionId }),
      service.getMessages({ id: sessionId, limit: 80 }),
      service.listModels({ sessionId }) as Promise<readonly TuiModel[]>,
    ]);
    const session = sessionResponse.session;
    if (!session)
      throw new Error(`Runtime did not return Session ${sessionId}.`);
    const selected = models.find((model) => model.selected === true);
    const model =
      selected &&
      (selected.providerId !== session.model?.providerId ||
        selected.modelId !== session.model?.modelId)
        ? selected
        : (session.model ?? selected);
    return projectTuiContextSnapshot({
      messages: messagesResponse.messages ?? [],
      active: session.status?.statusType === 1,
      model,
    });
  }

  async getActiveRun(sessionId: string): Promise<TuiActiveRunSnapshot> {
    const service = this.context.service("session.active-run");
    const sessionResponse = await service.getSession({ id: sessionId });
    const session = sessionResponse.session;
    if (!session)
      throw new Error(`Runtime did not return Session ${sessionId}.`);
    const started = session.status?.statusType === 1;
    const [activeTurn, permissions, questionnaire] = started
      ? await Promise.all([
          service.getActiveTurn(sessionId),
          service.listPendingPermissions({}),
          service.getPendingQuestionnaire({
            name: session.agentName ?? this.defaultAgentName,
            sessionId,
          }),
        ])
      : [undefined, { requests: [] }, {}];
    const decisionBlocked =
      started &&
      (questionnaire.request !== undefined ||
        (permissions.requests ?? []).some(
          (request) => request.sessionId === sessionId,
        ));
    const turnId = activeTurn?.turnId;
    const steerable =
      started &&
      !decisionBlocked &&
      activeTurn?.busyReason === "turn" &&
      activeTurn.locallyOwned;
    return {
      schemaVersion: 1,
      sessionId,
      state: started
        ? decisionBlocked
          ? "decision-blocked"
          : "running"
        : session.status?.statusType === 2 || session.status?.statusType === 3
          ? "terminal"
          : "idle",
      ...(turnId ? { turnId } : {}),
      actions: { steer: steerable },
    };
  }

  async listSkills(
    agentName = this.defaultAgentName,
    keyword?: string,
    workspaceDir = this.workspaceDir,
  ): Promise<TuiSkillList> {
    const service = this.context.service("skill.list");
    const result = await service.listRuntimeSkills({
      agentName,
      ...(workspaceDir ? { workspaceDir } : {}),
      includePluginSkills: true,
    });
    const normalizedKeyword = keyword?.trim().toLocaleLowerCase();
    const skills = normalizedKeyword
      ? (result.skills ?? []).filter((skill) =>
          `${skill.name} ${skill.displayName ?? ""} ${skill.description ?? ""}`
            .toLocaleLowerCase()
            .includes(normalizedKeyword),
        )
      : (result.skills ?? []);
    return { skills, hasMore: false };
  }

  inspectProjectMcp(
    sessionId: string,
  ): Promise<TuiProjectMcpPreview | undefined> {
    return this.context
      .service("mcp.project.inspect")
      .inspectProjectMcp(sessionId);
  }
  async listMcpServers(
    keyword?: string,
    sessionId?: string,
  ): Promise<TuiMcpServer[]> {
    const request = {
      ...(keyword ? { keyword } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    const result = await this.context
      .service("mcp.list")
      .listMcpServers(request);
    return result.servers as TuiMcpServer[];
  }
}

function modelRequest(model: TuiModelSelection): {
  providerId: string;
  modelId: string;
  variant?: string;
  contextLimit?: number;
  thinking?: TuiModelSelection["thinking"];
} {
  const effort = model.thinking?.effort?.trim();
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
    ...(model.contextLimit !== undefined
      ? { contextLimit: model.contextLimit }
      : {}),
    ...(effort ? { thinking: { effort } } : {}),
  };
}

function projectTuiModelCatalogEntry(input: unknown): TuiModel {
  const model = input as TuiModel & {
    readonly thinkingConfig?: TuiModel["thinkingConfig"] & {
      readonly default_value?: string;
    };
  };
  const thinkingConfig = model.thinkingConfig;
  if (!thinkingConfig) return model;
  const { default_value: defaultValueSnakeCase, ...fields } = thinkingConfig;
  return {
    ...model,
    thinkingConfig: {
      ...fields,
      ...(fields.defaultValue !== undefined
        ? { defaultValue: fields.defaultValue }
        : defaultValueSnakeCase !== undefined
          ? { defaultValue: defaultValueSnakeCase }
          : {}),
    },
  };
}
