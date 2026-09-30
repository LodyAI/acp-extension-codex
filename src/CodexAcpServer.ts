import {clientSupportsNotices} from "./SessionNotice";
import {GOAL_EXTENSION_VERSION, GOAL_CONTROL_ACTIONS} from "./GoalExtension";
import * as acp from "@agentclientprotocol/sdk";
import {
    supportsLodySubagentEvents,
    type LodyMcpAppLoadRequest,
    type LodyMcpAppLoadResponse,
    type LodyMcpAppResourceReadRequest,
    type LodyMcpAppResourceReadResponse,
    type LodyMcpAppToolCallRequest,
    type LodyMcpAppToolCallResponse,
} from "acp-extension-core";
import {RequestError, type SessionId, type SessionModeState} from "@agentclientprotocol/sdk";
import {CodexEventHandler, type CompletedPlan, failureWasShownAsMessage, sanitizeProviderErrorText} from "./CodexEventHandler";
import {CodexApprovalHandler} from "./permissions/CodexApprovalHandler";
import {PermissionLifecycleContext} from "./permissions/lifecycle";
import {CodexElicitationHandler} from "./CodexElicitationHandler";
import {type CodexAuthRequest, getCodexAuthMethods, getCodexAuthMethodsV2, isCodexAuthRequest} from "./CodexAuthMethod";
import {clientSupportsUrlElicitation} from "./ElicitationCapabilities";
import {
    CodexAcpClient,
    type JsonObject,
    OPENAI_PROVIDER_ID,
    type SessionMetadata,
    type SessionMetadataWithThread,
    type UrlElicitationRequester
} from "./CodexAcpClient";
import {
    type ApprovalHandler,
    CodexAppServerClient,
    type ElicitationHandler,
    type McpStartupResult,
} from "./CodexAppServerClient";
import {isNoActiveTurnError, parseExpectedActiveTurnMismatch} from "./CodexThreadErrors";
import {type CodexConnection, startCodexConnection} from "./CodexJsonRpcConnection";
import {
    type AcpClientConnection,
    ACPSessionConnection,
    type AcpV2ClientConnection,
    AcpV2Connection,
    type ReplayMessageKind,
    type UpdateSessionEvent,
} from "./ACPSessionConnection";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {toV1ClientCapabilitiesView} from "./AcpV2ClientCapabilities";
import {toV1SetSessionConfigOptionRequest, toV2ConfigOptions} from "./AcpV2ConfigOptions";
import {
    isInsertedUserMessage,
    postInsertionFailureText,
    toV1PromptRequest,
    toV2IdleState,
    type UserMessageInsertion,
} from "./AcpV2Prompt";
import type {InputModality, ReasoningEffort, ServerNotification} from "./app-server";
import type {
    Account,
    AccountUpdatedNotification,
    Model,
    RateLimitSnapshot,
    ReasoningEffortOption,
    Thread,
    ThreadGoal,
    ThreadGoalStatus,
    ThreadItem,
    ThreadItemEntry,
    TurnStatus,
    UserInput
} from "./app-server/v2";
import type {RateLimitsMap} from "./RateLimitsMap";
import {ModelId} from "./ModelId";
import {AgentMode, MODE_CONFIG_ID} from "./AgentMode";
import {
    LODY_PLAN_MODE_CONFIG_ID,
    createCollaborationModeConfigOption,
    DEFAULT_COLLABORATION_MODE,
    parseCollaborationMode,
    PLAN_COLLABORATION_MODE,
} from "./CollaborationModeConfig";
import type {ModeKind} from "./app-server/ModeKind";
import {
    createModelConfigOption,
    createReasoningEffortConfigOption,
    findSupportedEffort,
    formatModelDisplayName,
    MODEL_CONFIG_ID,
    REASONING_EFFORT_CONFIG_ID,
} from "./ModelConfigOption";
import type {TokenCount} from "./TokenCount";
import {toPromptUsage} from "./TokenCount";
import {CodexTurnUsage} from "./CodexUsage";
import {CodexCommands, GOAL_CONTINUATION_PROMPT, type CommandHandleOptions} from "./CodexCommands";
import {GoalPromptLifecycle} from "./GoalPromptLifecycle";
import {SteeringQueue} from "./SteeringQueue";
import type {QuotaMeta} from "./QuotaMeta";
import {logger} from "./Logger";
import {sanitizeMcpServerName} from "./McpServerName";
import {createResponseItemHistoryFallbackUpdates} from "./ResponseItemHistoryFallback";
import {toLodyRateLimitsResponse} from "./LodyRateLimits";
import type {ToolCallReports} from "./ToolCallReports";
import {ToolCallReportingConnection} from "./ToolCallReportingConnection";
import {type AcpMcpServer, getMcpServerName, type WithAcpMcpServers} from "./McpServerConfig";
import {
    CODEX_STEER_APPLIED_METHOD,
    CODEX_LODY_CAPABILITIES,
    AUTH_STATUS_META_KEY,
    AUTH_STATUS_UPDATE_METHOD,
    authStatusCapability,
    type AuthStatus,
    GOAL_CONTROL_METHOD,
    isExtMethodRequest,
    parseGoalPromptControl,
    LEGACY_SET_SESSION_MODEL_METHOD,
    type LegacyLoadSessionResponse,
    type LegacyNewSessionResponse,
    type LegacyResumeSessionResponse,
    type LegacySessionModelState,
    type LegacySetSessionModelRequest,
    type LegacySetSessionModelResponse,
    type LodyReadSessionHistoryRequest,
    type LodyReadSessionHistoryResponse,
    SESSION_STEERING_METHOD,
    type SessionSteerRequest,
    type SessionSteeringResponse,
} from "./AcpExtensions";
import {AcpToolCallRenderer} from "./tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "./tool-calls/ClientCapabilities";
import {CollabAgentReporter} from "./tool-calls/reporters/CollabAgentReporter";
import {CommandReporter} from "./tool-calls/reporters/CommandReporter";
import {CompactionReporter} from "./tool-calls/reporters/CompactionReporter";
import {DynamicToolReporter} from "./tool-calls/reporters/DynamicToolReporter";
import {FileChangeReporter} from "./tool-calls/reporters/FileChangeReporter";
import {ImageGenerationReporter} from "./tool-calls/reporters/ImageGenerationReporter";
import {ImageViewReporter} from "./tool-calls/reporters/ImageViewReporter";
import {McpStartupReporter} from "./tool-calls/reporters/McpStartupReporter";
import {McpToolReporter} from "./tool-calls/reporters/McpToolReporter";
import {PlanReviewReporter} from "./tool-calls/reporters/PlanReviewReporter";
import {SubagentActivityReporter} from "./tool-calls/reporters/SubagentActivityReporter";
import {WebSearchReporter} from "./tool-calls/reporters/WebSearchReporter";
import {
    clientSupportsBooleanConfigOptions,
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
    modelSupportsFast,
    resolveFastServiceTier,
} from "./FastModeConfig";
import packageJson from "../package.json";
import {isJetBrains2026_1Client} from "./JBUtils";
import {resolveTerminalOutputMode, type TerminalOutputMode} from "./TerminalOutputMode";
import {sanitizeReasoningParts} from "./ReasoningText";
import {clientSupportsPlanUpdates} from "./PlanCapabilities";
import {
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
    createCodexAgentMessageMeta,
    createMessagePhaseMeta,
    createCodexMessagePhaseMeta,
    createUserMessageChunk,
} from "./ContentChunks";
import {
    goalSessionInfoUpdate,
    sameThreadGoalSnapshot,
    type ThreadGoalSnapshot,
    toThreadGoalSnapshot,
} from "./ThreadGoalSnapshot";
import {
    clientSupportsSubagents,
    type SubagentAwareSessionCapabilities,
} from "./subagents/AcpSubagents";
import {CodexSubagentEventRouter} from "./subagents/CodexSubagentEventRouter";
import {nameFromAgentPath} from "./subagents/CodexAgentPath";
import {
    fromAccount,
    fromAccountUpdated,
    gatewayStatus,
    sameAuthStatus,
} from "./AuthStatusMeta";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {
    AIR_AGENT_FILE_CHANGE_REPORT_KEY,
    AIR_ASYNC_TASKS_KEY,
    AIR_DIFF_PATCH_KEY,
    AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
    AIR_PLAN_CONTENT_DELTA_KEY,
    AIR_RAW_INPUT_RENDERING_KEY,
    AIR_RECOMMENDED_CONFIG_VALUE_KEY,
    AIR_EXTENSION_CAPABILITIES_KEY,
    AIR_EXTENSION_VERSION,
    AIR_GOAL_KEY,
    AIR_EXTENSION_VERSION_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    clientSupportsAirCapability,
    JETBRAINS_META_KEY,
} from "./AirExtension";
import {ASYNC_TASK_STOP_METHOD} from "./async-tasks/AsyncTaskExtension";
import {CodexBackgroundTerminalTasks} from "./async-tasks/CodexBackgroundTerminalTasks";
import {clientSupportsCompaction, CodexSessionCompactions, createCompactionUpdate} from "./CodexSessionCompactions";
import {CodexSessionToolCalls} from "./CodexSessionToolCalls";
import {clientSupportsMcpApps, McpAppCalls, readMcpAppMeta} from "./McpApps";
import {
    type AgentFileChangeReport,
    type AgentFileChangeReportRequest,
    type AgentFileChangeReportUnavailableReason,
    type AgentFileChangeWorkspace,
    AgentFileChangeReportError,
    captureAgentFileChangeWorkspace,
    createReportedAgentFileChangeReport,
    createUnavailableAgentFileChangeReport,
    parseAgentFileChangeReportRequest,
} from "./AgentFileChangeReport";


export interface SessionState {
    turnUsage?: import("./CodexUsage").CodexTurnUsage;
    sessionId: string,
    currentModelId: string,
    availableModels: Array<Model>,
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    supportedInputModalities: Array<InputModality>,
    agentMode: AgentMode,
    collaborationMode: ModeKind,
    /** The active turn: its completion, errors and stop reason are matched against this id. */
    currentTurnId: string | null;
    /**
     * The id from the latest `turn/started`, which `turn/interrupt` and `turn/steer` need. It
     * differs from `currentTurnId` only for a review: Codex reports the review's events and
     * completion under the parent turn id, but treats the reviewer child turn as the running one.
     */
    interruptTurnId: string | null;
    /**
     * The Codex-reported turn currently running on this thread (`turn/started` to
     * `turn/completed`), tracked independently of whether a `session/prompt` started it. Backs
     * the v2 "Codex turn running" busy signal and the `running`/`idle` states sent for a turn no
     * v2 prompt owns (an auto goal continuation, or a turn Codex starts right after
     * `session/resume`).
     */
    codexReportedRunningTurnId: string | null;
    lastTokenUsage: TokenCount | null;
    totalTokenUsage: TokenCount | null;
    modelContextWindow: number | null;
    rateLimits: RateLimitsMap | null;
    account: Account | null;
    authConfigured: boolean;
    authProvider: string | null;
    cwd: string;
    additionalDirectories: string[];
    mcpServers?: Array<AcpMcpServer>;
    fastModeEnabled: boolean;
    currentModelSupportsFast: boolean;
    sessionMcpServers?: Array<string>;
    /** The capability choices of the client for tool call and plan reports. */
    clientCapabilities: ClientCapabilities;
    currentGoal?: ThreadGoalSnapshot | null;
    goalRevision: number;
    sessionTitle: string | null;
    sessionTitleSource: "unset" | "fallback" | "explicit" | "unknown";
    sessionFailure?: SessionFailure;
    subagents: CodexSubagentEventRouter;
    asyncTasks: CodexBackgroundTerminalTasks;
    compactions: CodexSessionCompactions;
    toolCallReports: ToolCallReports;
    /**
     * Tool-call items reported `item/started` but not yet `item/completed`, for item types
     * with no outstanding-item tracker of their own. A provider restart's close-out fails
     * whatever is still open here for a turn the dead app-server process never finished.
     */
    openToolCalls: CodexSessionToolCalls;
    /**
     * True only for a freshly forked session: `forkSession` unsubscribes the new thread right
     * after `thread/fork` on purpose, so no updates go out before the client's own
     * `session/resume`/`session/load` loads it . A provider restart
     * must leave such a session alone -- not resume it, and not install a baseline tracker for
     * it -- rather than pulling it into the app-server early.
     */
    awaitingClientLoad: boolean;
    /** Present only when the client negotiated `_meta.lody.mcpApps`. */
    mcpApps?: McpAppCalls;
}

type HistoryProjectionState = Pick<
    SessionState,
    "sessionId" | "sessionTitle" | "sessionTitleSource"
>;

export type SessionFailureCategory =
    | "connection" | "access" | "limit" | "request" | "service" | "unknown";

export type SessionFailureAction = "retry" | "login" | "new_session";

/**
 * How loudly the client should render the record. Absent on the wire means `error`, so an AIR build
 * that predates warning support keeps treating every record it receives as a failure.
 */
export type SessionFailureSeverity = "error" | "warning";

export interface SessionFailure {
    id: string;
    revision: number;
    category: SessionFailureCategory;
    severity: SessionFailureSeverity;
    title: string;
    details?: string;
    actions: SessionFailureAction[];
}

const CODEX_PROCESS_EXITED_ERROR_CODE = 1001;

/**
 * Backoff for re-sending `turn/interrupt` when Codex reports the turn is not
 * interruptible yet. Covers the sub-second window between a turn's first
 * streamed event -- which is what prompts a client to cancel in the first
 * place -- and Codex registering the turn as interruptible.
 */
const NO_ACTIVE_TURN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

/** A promise plus its own `resolve`, for settling a promise from outside its executor. */
function createDeferred<T>(): [Promise<T>, (value: T) => void] {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return [promise, resolve];
}

/**
 * Maps a turn id to the id Codex accepts for `turn/interrupt` and `turn/steer`. For the session's
 * current turn that is the latest `turn/started` id (a review's child turn), once one arrived.
 */
function codexRunningTurnId(sessionState: SessionState, turnId: string): string {
    return sessionState.currentTurnId === turnId
        ? sessionState.interruptTurnId ?? turnId
        : turnId;
}

/**
 * Simplified `turn/completed` status to v1 stop reason mapping for a turn no `session/prompt`
 * owns, where there is no richer terminal-failure handling to consult: only an interruption
 * counts as cancelled, a failure still ends the turn normally.
 */
function stopReasonForUnownedTurn(status: TurnStatus): acp.StopReason {
    switch (status) {
        case "completed":
        case "failed":
            return "end_turn";
        case "interrupted":
            return "cancelled";
        case "inProgress":
            // turn/completed never reports an in-progress turn.
            return "end_turn";
    }
}

/**
 * Approval/elicitation handlers for the baseline Codex turn tracker installed before any prompt
 * has run. They answer exactly as app-server already defaults to for a thread with no
 * handler registered, since nothing here can meaningfully act on a request until a real prompt
 * is issued.
 */
const DENY_ALL_APPROVALS: ApprovalHandler = {
    handleCommandExecution: async () => ({decision: "cancel"}),
    handleFileChange: async () => ({decision: "cancel"}),
    handlePermissionsRequest: async () => ({permissions: {}, scope: "turn", strictAutoReview: false}),
};

const DENY_ALL_ELICITATIONS: ElicitationHandler = {
    handleElicitation: async () => ({action: "cancel", content: null, _meta: null}),
    handleUserInput: async () => ({answers: {}}),
};

function clientSupportsTypedSessionFailures(capabilities: acp.ClientCapabilities | null): boolean {
    return clientSupportsAirCapability(capabilities, AIR_SESSION_FAILURE_KEY);
}

function clientSupportsAgentFileChangeReports(capabilities: acp.ClientCapabilities | null): boolean {
    return clientSupportsAirCapability(capabilities, AIR_AGENT_FILE_CHANGE_REPORT_KEY);
}

interface ActiveAuthState {
    account: Account | null;
    authConfigured: boolean;
}

type SessionOpenOperation =
    | { kind: "new"; request: WithAcpMcpServers<acp.NewSessionRequest> }
    | { kind: "resume"; request: WithAcpMcpServers<acp.ResumeSessionRequest> }
    | { kind: "fork"; request: WithAcpMcpServers<acp.ForkSessionRequest> };

type SessionOpenResult = [
    SessionId,
    LegacySessionModelState,
    SessionModeState,
    acp.AvailableCommand[],
];

interface PendingMcpStartupSession {
    requestedServers: Set<string>;
    startup: Promise<McpStartupResult>;
}

interface PendingTurnStart {
    promise: Promise<string | null>;
    resolve: (turnId: string | null) => void;
}

/**
 * One session's place in the shared per-session turn-start FIFO (see
 * `CodexAcpServer.acquireTurnStartReservation`). `wait` resolves once every earlier reservation
 * on the session has released; `release` must be called exactly once, by whoever ends up owning
 * the turn this reservation was taken for, so the next queued starter can proceed.
 *
 * `needsWait` is false when there was nothing to wait for (a fresh session, or the previous
 * holder already released). Callers should skip `await wait` in that case: awaiting an
 * already-resolved promise still costs a microtask tick, which is enough to reorder synchronous
 * setup (event-subscription registration, etc.) against a caller that fires a prompt without
 * awaiting it and immediately does other synchronous work.
 */
interface TurnStartReservation {
    wait: Promise<void>;
    needsWait: boolean;
    release: () => void;
}

interface ActivePrompt {
    completion: Promise<void>;
    closeSignal: Promise<null>;
    cancelSignal: Promise<null>;
    signal: AbortSignal;
    /**
     * Aborted for outbound permission/elicitation requests only (plain `session/cancel`,
     * `requestCancel`, `requestClose`). Kept separate from `signal`, which also drives pre-turn
     * prompt flow (`cancelBeforeTurnStarted`, local commands, native-subagent waits,
     * `interruptLateStartedTurn`) and must keep its current behavior on plain `session/cancel`.
     */
    interactionSignal: AbortSignal;
    /** Set by plain `session/cancel` so the plan-review branch can detect cancellation without `signal` being aborted. */
    cancelRequested: boolean;
    currentTurn: { threadId: string, turnId: string } | null;
    hasCompletedTurn: boolean;
    nativeCommandInFlight: boolean;
    requestCancel: () => void;
    requestClose: () => void;
    abortInteractions: () => void;
    complete: () => void;
}

interface PendingSteer {
    activePrompt: ActivePrompt;
    threadId: string;
    turnId: string;
    requestPending: boolean;
    acknowledgement: Promise<void> | null;
    applied: Promise<void>;
    resolveApplied: () => void;
}

export interface CodexProcessState {
    connection: CodexConnection;
    codexPath: string | undefined;
    config: JsonObject | undefined;
    modelProvider: string | undefined;
    stderr: string;
    stderrProcess?: CodexConnection["process"];
}

export class CodexAcpServer {
    private codexAcpClient: CodexAcpClient;
    private readonly connection: AcpClientConnection;
    private readonly reportingConnection: ToolCallReportingConnection;
    /** ACP protocol version of the connection this agent serves, fixed by the protocol router. */
    readonly protocolVersion: 1 | 2;
    /** The v2 client handle; `null` on a v1 connection. */
    private readonly v2Connection: AcpV2ClientConnection | null;
    private readonly defaultAuthRequest: CodexAuthRequest | null;
    private readonly getExitCode: () => number | null;
    private readonly getRecentStderr: () => string;
    private readonly managedChatgptProfile: boolean;
    private readonly sessionFailureEpoch: string;
    private availableCommands: CodexCommands;
    private clientInfo: acp.Implementation | null;
    private clientCapabilities: acp.ClientCapabilities | null;
    /** The capability choices of the client for tool call and plan reports. */
    private capabilities: ClientCapabilities;
    private booleanConfigOptionsSupported: boolean;
    /** Last `authStatus` pushed to the client; used to suppress duplicates. */
    private currentAuthStatus: AuthStatus | null;

    private readonly sessions: Map<string, SessionState>;
    private readonly pendingMcpStartupSessions: Map<string, PendingMcpStartupSession>;
    private readonly pendingTurnStarts: Map<string, PendingTurnStart>;
    private readonly activePrompts: Map<string, ActivePrompt>;
    private readonly goalControlGenerations = new Map<string, number>();
    private readonly historyTurnIds = new WeakMap<ThreadItem, string>();
    private readonly pendingSteers: Map<string, Map<string, PendingSteer>>;
    /** Tail of the per-session turn-start FIFO; see `acquireTurnStartReservation`. */
    private readonly turnStartQueueTail: Map<string, {promise: Promise<void>; settled: boolean}>;
    private readonly steeringQueues: Map<string, SteeringQueue>;
    /**
     * Steers awaiting their `userMessage` landing, keyed by the minted `clientUserMessageId`
     * passed to `turn/steer`. Used only to show a v2 live `user_message` when a steer injected
     * into an already-running turn lands (there is no `prompt()` call to hook into for that
     * path); v1 has nothing to emit. A steer that starts a new turn instead goes through
     * `prompt()`'s own `UserMessageInsertion` tracking and never enters this map.
     */
    private readonly pendingSteerLandings: Map<string, {sessionId: string; prompt: acp.ContentBlock[]}>;
    /** Sessions with a v2 prompt that has not finished yet, including before its turn starts. */
    private readonly v2PromptsInFlight = new Set<string>();
    /**
     * Per-session callbacks that abort a v2 `session/prompt` still waiting in the turn-start FIFO
     * (queued behind a running turn, not yet inserted). `session/cancel`/`session/close` drop the
     * whole queue for a session by invoking every registered callback here.
     */
    private readonly queuedV2PromptCancellers = new Map<string, Set<() => void>>();
    private readonly closingSessions: Map<string, number>;
    private readonly sessionGenerations: Map<string, number>;
    private readonly sessionOpenGenerations: Map<string, number>;
    private readonly permissionLifecycleContexts: WeakMap<SessionState, PermissionLifecycleContext>;
    private readonly codexProcessState: CodexProcessState | null;
    private codexProcessGeneration = 0;
    private initializeRequest: Pick<acp.InitializeRequest, "clientInfo"> | null = null;
    private providerUpdate: Promise<void> | null = null;

    constructor(
        connection: AcpClientConnection | AcpV2Connection,
        codexAcpClient: CodexAcpClient,
        defaultAuthRequest?: CodexAuthRequest,
        getExitCode?: () => number | null,
        getRecentStderr?: () => string,
        codexProcessState?: CodexProcessState,
        managedChatgptProfile = false,
    ) {
        this.sessions = new Map();
        this.pendingMcpStartupSessions = new Map();
        this.pendingTurnStarts = new Map();
        this.activePrompts = new Map();
        this.pendingSteers = new Map();
        this.turnStartQueueTail = new Map();
        this.steeringQueues = new Map();
        this.pendingSteerLandings = new Map();
        this.closingSessions = new Map();
        this.sessionGenerations = new Map();
        this.sessionOpenGenerations = new Map();
        this.permissionLifecycleContexts = new WeakMap();
        if (connection instanceof AcpV2Connection) {
            this.protocolVersion = 2;
            this.v2Connection = connection.client;
            this.reportingConnection = new ToolCallReportingConnection(connection.extensionOnlyV1View());
            this.connection = this.reportingConnection.asClientConnection();
            connection.registerView(this.connection);
            // A permission request that outlives its turn must not undo the `idle` already sent
            // for it: only send `running` back if the session is actually still busy --
            // either a Codex turn is running, or a v2 prompt is in flight between two Codex
            // turns of the same prompt (e.g. the plan/implementation approval gap), where no
            // `codexReportedRunningTurnId` is set yet but the client is still mid-`requires_action`.
            connection.setTurnRunningCheck((sessionId) => this.isSessionBusy(sessionId));
        } else {
            this.protocolVersion = 1;
            this.v2Connection = null;
            this.reportingConnection = new ToolCallReportingConnection(connection);
            this.connection = this.reportingConnection.asClientConnection();
        }
        this.codexAcpClient = codexAcpClient;
        this.defaultAuthRequest = defaultAuthRequest ?? null;
        this.codexProcessState = codexProcessState ?? null;
        this.captureStderr();
        this.getExitCode = getExitCode ?? (() => this.codexProcessState?.connection.process.exitCode ?? null);
        this.getRecentStderr = getRecentStderr ?? (() => this.codexProcessState?.stderr ?? "");
        this.managedChatgptProfile = managedChatgptProfile;
        this.sessionFailureEpoch = randomUUID();
        this.clientInfo = null;
        this.clientCapabilities = null;
        this.capabilities = ClientCapabilities.DEFAULT;
        this.booleanConfigOptionsSupported = false;
        this.currentAuthStatus = null;
        this.availableCommands = this.createAvailableCommands(codexAcpClient);
        this.observeCodexProcess();
    }

    private createAvailableCommands(client: CodexAcpClient): CodexCommands {
        return new CodexCommands(
            this.connection,
            client,
            (operation) => this.runWithProcessCheck(operation),
            () => this.refreshAuthState(null)
        );
    }

    async initialize(
        _params: acp.InitializeRequest,
    ): Promise<acp.InitializeResponse> {
        logger.log("Initialize request received");
        this.clientInfo = _params.clientInfo ?? null;
        this.clientCapabilities = _params.clientCapabilities ?? null;
        this.initializeRequest = _params;
        this.capabilities = ClientCapabilities.from(_params.clientCapabilities);
        this.reportingConnection.reports.compareMeta = this.capabilities.airToolCallContract;
        this.booleanConfigOptionsSupported = clientSupportsBooleanConfigOptions(_params.clientCapabilities);
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize(_params));
        this.publishFirstAuthStatusAfterResponse();
        const sessionCapabilities: SubagentAwareSessionCapabilities = {
            resume: { },
            list: { },
            close: { },
            delete: { },
            fork: { },
            additionalDirectories: {},
            subagents: {},
        };
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            agentCapabilities: {
                auth: {
                    logout: {},
                },
                providers: {},
                loadSession: true,
                promptCapabilities: {
                    embeddedContext: true,
                    image: true
                },
                sessionCapabilities,
                mcpCapabilities: {
                    acp: false,
                    http: true,
                    sse: false
                },
                _meta: {
                    lody: CODEX_LODY_CAPABILITIES,
                    // Presence means "this agent pushes `_auth/status_update`". It
                    // never carries a payload, and the client never asks for one.
                    [AUTH_STATUS_META_KEY]: authStatusCapability(),
                },
            },
            authMethods: getCodexAuthMethods(_params.clientCapabilities),
            _meta: this.initializeExtensionsMeta(1),
        };
    }

    async initializeV2(
        params: acpV2.InitializeRequest,
    ): Promise<acpV2.InitializeResponse> {
        logger.log("Initialize request received", {protocolVersion: params.protocolVersion});
        // Existing capability readers take the v1 shape; v2 fields they read keep their relative path.
        const clientCapabilities = toV1ClientCapabilitiesView(params.capabilities);
        this.clientInfo = params.info;
        this.clientCapabilities = clientCapabilities;
        this.initializeRequest = {clientInfo: params.info};
        this.capabilities = ClientCapabilities.fromV2(clientCapabilities);
        this.reportingConnection.reports.compareMeta = this.capabilities.airToolCallContract;
        // Boolean config options are baseline on v2, so there is nothing to probe.
        this.booleanConfigOptionsSupported = true;
        await this.runWithProcessCheck(() => this.codexAcpClient.initialize({clientInfo: params.info, clientCapabilities}));
        this.publishFirstAuthStatusAfterResponse();
        return {
            protocolVersion: 2,
            info: {
                name: packageJson.name,
                title: "Codex",
                version: packageJson.version,
            },
            capabilities: {
                _meta: {lody: CODEX_LODY_CAPABILITIES},
                auth: {
                    _meta: {
                        // Presence means "this agent pushes `_auth/status_update`".
                        [AUTH_STATUS_META_KEY]: authStatusCapability(),
                    },
                },
                providers: {},
                session: {
                    prompt: {
                        embeddedContext: {},
                        image: {},
                    },
                    mcp: {
                        stdio: {},
                        http: {},
                    },
                    delete: {},
                    additionalDirectories: {},
                    fork: {},
                },
            },
            authMethods: getCodexAuthMethodsV2(clientCapabilities),
            _meta: this.initializeExtensionsMeta(2),
        };
    }

    /**
     * The extension metadata of the initialize response. Only AIR gets the AIR extension, see
     * `docs/air-extensions.md`. v2 has its own terminal, diff and plan updates, so the AIR
     * tool call and plan capabilities are not offered there.
     */
    private initializeExtensionsMeta(protocolVersion: 1 | 2): Record<string, unknown> {
        const airCapabilities = protocolVersion === 1
            ? [
                AIR_SESSION_FAILURE_KEY,
                AIR_DIFF_PATCH_KEY,
                AIR_AGENT_FILE_CHANGE_REPORT_KEY,
                AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
                AIR_ASYNC_TASKS_KEY,
                AIR_RECOMMENDED_CONFIG_VALUE_KEY,
                AIR_RAW_INPUT_RENDERING_KEY,
                AIR_PLAN_CONTENT_DELTA_KEY,
            ]
            : [
                AIR_SESSION_FAILURE_KEY,
                AIR_AGENT_FILE_CHANGE_REPORT_KEY,
                AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
                AIR_ASYNC_TASKS_KEY,
                AIR_RECOMMENDED_CONFIG_VALUE_KEY,
            ];
        return {
            steering: {
                supported: true,
            },
            ...(this.capabilities.airClient ? {
                [JETBRAINS_META_KEY]: {
                    [AIR_META_KEY]: {
                        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                        [AIR_GOAL_KEY]: {
                            version: GOAL_EXTENSION_VERSION,
                            controlMethod: GOAL_CONTROL_METHOD,
                            actions: [...GOAL_CONTROL_ACTIONS],
                        },
                        [AIR_EXTENSION_CAPABILITIES_KEY]: airCapabilities,
                    },
                },
            } : {}),
        };
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        const methodRequest = { method: method, params: params };
        if (!isExtMethodRequest(methodRequest)) {
            return {};
        }
        switch (methodRequest.method) {
            case "authentication/status":
                return await this.runWithProcessCheck(() => this.codexAcpClient.getAuthenticationStatus());
            case "authentication/logout": {
                await this.logout({});
                return {};
            }
            case LEGACY_SET_SESSION_MODEL_METHOD:
                return await this.unstable_setSessionModel(this.parseLegacySetSessionModelParams(methodRequest.params));
            case SESSION_STEERING_METHOD:
                return await this.executeOrQueueSteeringRequest(this.parseSessionSteerParams(methodRequest.params));
            case ASYNC_TASK_STOP_METHOD: {
                if (this.providerUpdate !== null) {
                    await this.providerUpdate;
                }
                const sessionState = this.sessions.get(methodRequest.params.sessionId);
                if (!sessionState) return {stopped: false};
                return {
                    stopped: await this.runWithProcessCheck(
                        () => sessionState.asyncTasks.stop(methodRequest.params.asyncTaskId),
                    ),
                };
            }
            case GOAL_CONTROL_METHOD: {
                const sessionState = this.sessions.get(methodRequest.params.sessionId);
                if (!sessionState) {
                    throw RequestError.invalidParams(undefined, `Unknown session: ${methodRequest.params.sessionId}`);
                }
                const sessionGeneration = this.getSessionGeneration(sessionState.sessionId);
                const goalControlGeneration = this.bumpGoalControlGeneration(sessionState.sessionId);
                if (methodRequest.params.action === "set") {
                    const objective = methodRequest.params.objective;
                    let updatedGoal: ThreadGoal | null = null;
                    const turnCompleted = await this.runWithProcessCheck(() => this.codexAcpClient.setGoal(
                        sessionState.sessionId,
                        objective,
                        undefined,
                        (goal) => {
                            updatedGoal = goal;
                        },
                    ));
                    if (turnCompleted === null && updatedGoal !== null) {
                        await this.startGoalContinuationIfCurrent(
                            sessionState,
                            sessionGeneration,
                            goalControlGeneration,
                            updatedGoal,
                        );
                    }
                } else if (methodRequest.params.action === "pause") {
                    const goal = await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(sessionState.sessionId, "paused"));
                    if (this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(goal), false);
                    }
                } else if (methodRequest.params.action === "resume") {
                    let updatedGoal: ThreadGoal | null = null;
                    const turnCompleted = await this.runWithProcessCheck(() => this.codexAcpClient.resumeGoal(
                        sessionState.sessionId,
                        undefined,
                        (goal) => {
                            updatedGoal = goal;
                        },
                    ));
                    if (updatedGoal !== null && this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(updatedGoal), false);
                    }
                    if (turnCompleted === null && updatedGoal !== null) {
                        await this.startGoalContinuationIfCurrent(
                            sessionState,
                            sessionGeneration,
                            goalControlGeneration,
                            updatedGoal,
                        );
                    }
                } else if (methodRequest.params.action === "clear") {
                    await this.runWithProcessCheck(() => this.codexAcpClient.clearGoal(sessionState.sessionId));
                    if (this.sessionPublishIsCurrent(sessionState, sessionGeneration)) {
                        await this.publishGoalSnapshot(sessionState, null, false);
                    }
                }
                return {};
            }
        }
    }

    async mcpAppLoad(params: LodyMcpAppLoadRequest): Promise<LodyMcpAppLoadResponse> {
        return await this.withMcpApps(params.sessionId, (calls, appServer) =>
            calls.load(appServer, params.sessionId, params.toolCallId));
    }

    async mcpAppResourceRead(params: LodyMcpAppResourceReadRequest): Promise<LodyMcpAppResourceReadResponse> {
        return await this.withMcpApps(params.sessionId, (calls, appServer) =>
            calls.readResource(appServer, params.sessionId, params.toolCallId, params.uri));
    }

    async mcpAppToolCall(
        params: Omit<LodyMcpAppToolCallRequest, "arguments"> & {arguments?: Record<string, unknown> | undefined},
    ): Promise<LodyMcpAppToolCallResponse> {
        return await this.withMcpApps(params.sessionId, (calls, appServer) =>
            calls.callTool(appServer, params.sessionId, params.toolCallId, params.name, params.arguments));
    }

    private async withMcpApps<T>(
        sessionId: string,
        operation: (calls: McpAppCalls, appServer: CodexAppServerClient) => Promise<T>,
    ): Promise<T> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw RequestError.invalidParams(undefined, `Unknown session: ${sessionId}`);
        }
        const calls = sessionState.mcpApps;
        if (!calls) {
            throw RequestError.invalidRequest(undefined, "MCP Apps were not negotiated for this client");
        }
        return await this.runWithProcessCheck(() => operation(calls, this.codexAcpClient.appServerClient));
    }

    async checkAuthorization(){
        const authNeeded = await this.runWithProcessCheck(() => this.codexAcpClient.authRequired());
        logger.log("Auth requirement checked", {authRequired: authNeeded});
        if (authNeeded) {
            if (this.defaultAuthRequest) {
                logger.log("Authenticating with default auth request...", {
                    authRequest: this.defaultAuthRequest
                });
                await this.authenticate(this.defaultAuthRequest)
                logger.log("Authentication completed");
            } else {
                logger.log("Authentication required but no default auth request provided, return to IDE");
                throw RequestError.authRequired();
            }
        }
    }

    async readRateLimits() {
        return toLodyRateLimitsResponse(
            await this.runWithProcessCheck(() => this.codexAcpClient.getRateLimits()),
        );
    }

    async getOrCreateSession(request: WithAcpMcpServers<acp.NewSessionRequest> | WithAcpMcpServers<acp.ResumeSessionRequest>): Promise<SessionOpenResult> {
        try {
            return await this.tryCreateSession(request);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    private async getOrForkSession(request: WithAcpMcpServers<acp.ForkSessionRequest>): Promise<SessionOpenResult> {
        try {
            return await this.tryOpenSession({kind: "fork", request});
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            await this.handleError(error);
            throw e;
        }
    }

    private handleManagedChatgptRefreshError(error: unknown): void {
        if (!this.managedChatgptProfile || !(error instanceof Error)
            || !error.message.includes("Your access token could not be refreshed")) {
            return;
        }
        // Another native process may already have refreshed this profile's shared keyring entry.
        // An error from this process cannot authorize deleting that entry.
        const message = "This Codex account could not refresh. Its saved credentials were kept. Restart the session to retry; if authentication still fails, add a new provider.";
        if (error.message.includes("refresh token was already used")) {
            throw RequestError.internalError({kind: "codex_refresh_contention", message}, message);
        }
        throw RequestError.internalError(message);
    }

    async handleError(e: Error){
        this.handleManagedChatgptRefreshError(e);
        if (e.message.includes("log out") || e.message.includes("cloud requirements")) {
            if (this.managedChatgptProfile) return;
            await this.runWithProcessCheck(() => this.codexAcpClient.logout());
            await this.refreshAuthState(null);
            throw RequestError.internalError(`${(e.message)}\n\nYou have been logged out. Please try again.`);
        }
        const configPath = this.codexAcpClient.getHomePath() ?? "global";
        if (e.message.includes("load config")) {
            throw RequestError.internalError(`${e.message}\n\nCheck ${configPath} and project .codex directories, especially their config.toml files, or any CODEX_CONFIG override.`);
        }
        this.throwWorkspaceRoutingError(e);
    }

    /**
     * The app-server reports workspace routing discovery failures as internal
     * errors while opening a session. Only the two observed texts are matched:
     * they are reachability problems, so preserve the original message and add
     * a network hint. They carry no authentication evidence and never map to
     * `authRequired` or a forced logout.
     */
    private throwWorkspaceRoutingError(error: unknown): void {
        if (!(error instanceof Error)) {
            return;
        }
        if (!error.message.includes("workspace routing discovery failed")
            && !error.message.includes("workspace routing discovery timed out")) {
            return;
        }
        const message = `${error.message}\n\nCheck the network connection and any proxy or VPN settings, then try again.`;
        throw RequestError.internalError({kind: "codex_workspace_routing", message}, message);
    }

    private beginSessionOpen(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId);
        if (this.sessionIsClosing(sessionId)) {
            throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
        }
        this.sessionOpenGenerations.set(sessionId, generation);
        return generation;
    }

    private sessionOpenCanInstall(sessionId: string, generation: number): boolean {
        return !this.sessionIsClosing(sessionId) && this.getSessionGeneration(sessionId) === generation;
    }

    private async cleanupStaleSessionOpen(sessionId: string, generation: number): Promise<boolean> {
        if (this.sessionOpenGenerations.get(sessionId) === generation) {
            if (!this.sessionIsClosing(sessionId)) {
                this.bumpSessionGeneration(sessionId);
            }
            this.beginSessionCloseFence(sessionId);
            try {
                await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(sessionId));
            } catch (err) {
                logger.error(`Failed to close stale session open for ${sessionId}`, err);
            } finally {
                this.endSessionCloseFence(sessionId);
            }
            return true;
        }
        return false;
    }

    private async closeStaleSessionOpen(sessionId: string, generation: number): Promise<void> {
        await this.cleanupStaleSessionOpen(sessionId, generation);
        throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
    }

    private sessionIsClosing(sessionId: string): boolean {
        return (this.closingSessions.get(sessionId) ?? 0) > 0;
    }

    private beginSessionCloseFence(sessionId: string): void {
        this.closingSessions.set(sessionId, (this.closingSessions.get(sessionId) ?? 0) + 1);
    }

    private endSessionCloseFence(sessionId: string): void {
        const count = this.closingSessions.get(sessionId) ?? 0;
        if (count <= 1) {
            this.closingSessions.delete(sessionId);
            return;
        }
        this.closingSessions.set(sessionId, count - 1);
    }

    private getSessionGeneration(sessionId: string): number {
        return this.sessionGenerations.get(sessionId) ?? 0;
    }

    private bumpSessionGeneration(sessionId: string): number {
        const generation = this.getSessionGeneration(sessionId) + 1;
        this.sessionGenerations.set(sessionId, generation);
        return generation;
    }

    async tryCreateSession(request: WithAcpMcpServers<acp.NewSessionRequest> | WithAcpMcpServers<acp.ResumeSessionRequest>): Promise<SessionOpenResult> {
        return await this.tryOpenSession("sessionId" in request
            ? {kind: "resume", request}
            : {kind: "new", request});
    }

    private async tryOpenSession(operation: SessionOpenOperation): Promise<SessionOpenResult> {
        const {request} = operation;
        let openedSession = operation.kind === "resume"
            ? {
                sessionId: operation.request.sessionId,
                generation: this.beginSessionOpen(operation.request.sessionId),
            }
            : null;
        let subscribed = false;
        const onSubscribed = (reportedSessionId?: string): void => {
            const sessionId = reportedSessionId
                ?? (operation.kind === "resume" ? operation.request.sessionId : null);
            if (!sessionId) {
                throw RequestError.internalError("Codex subscribed without reporting a session id");
            }
            subscribed = true;
            if (!openedSession) {
                openedSession = {
                    sessionId,
                    generation: this.beginSessionOpen(sessionId),
                };
            }
        };
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        const [trackerReady, settleTrackerReady] = createDeferred<SessionState | null>();
        if (operation.kind === "resume") this.startCodexTurnTracker(operation.request.sessionId, trackerReady);
        let sessionMetadata: SessionMetadata;
        try {
            switch (operation.kind) {
                case "new":
                    logger.log("Create new session...");
                    sessionMetadata = await this.runWithProcessCheck(() =>
                        this.codexAcpClient.newSession(operation.request, onSubscribed)
                    );
                    break;
                case "resume":
                    logger.log(`Resume existing session: ${operation.request.sessionId}...`);
                    sessionMetadata = await this.runWithProcessCheck(() =>
                        this.codexAcpClient.resumeSession(operation.request, onSubscribed)
                    );
                    break;
                case "fork":
                    logger.log(`Fork existing session: ${operation.request.sessionId}...`);
                    sessionMetadata = await this.runWithProcessCheck(() =>
                        this.codexAcpClient.forkSession(operation.request)
                    );
                    break;
            }
        } catch (err) {
            settleTrackerReady(null);
            if (subscribed && openedSession) {
                await this.cleanupStaleSessionOpen(openedSession.sessionId, openedSession.generation);
            }
            throw err;
        }

        const {sessionId, currentModelId, models} = sessionMetadata;
        if (!openedSession) {
            openedSession = {
                sessionId,
                generation: this.beginSessionOpen(sessionId),
            };
        } else if (openedSession.sessionId !== sessionId) {
            if (subscribed) {
                await this.cleanupStaleSessionOpen(openedSession.sessionId, openedSession.generation);
            }
            throw RequestError.internalError(
                {expectedSessionId: openedSession?.sessionId, actualSessionId: sessionId},
                "Codex opened a different session than it reported",
            );
        }
        subscribed = true;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider);
        } catch (err) {
            settleTrackerReady(null);
            if (subscribed) {
                await this.cleanupStaleSessionOpen(sessionId, openedSession.generation);
            }
            throw err;
        }
        if (!this.sessionOpenCanInstall(sessionId, openedSession.generation)) {
            subscribed = false;
            await this.closeStaleSessionOpen(sessionId, openedSession.generation);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(
            requestedMcpServers,
            operation.kind !== "new",
        );
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            availableModels: models,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            collaborationMode: sessionMetadata.collaborationMode,
            currentTurnId: null,
            interruptTurnId: null,
            codexReportedRunningTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: authState.account,
            authConfigured: authState.authConfigured,
            authProvider: authProvider,
            cwd: request.cwd,
            additionalDirectories: sessionMetadata.additionalDirectories,
            mcpServers: requestedMcpServers,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
            clientCapabilities: this.capabilities,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: operation.kind === "resume" ? "unknown" : "unset",
            subagents: new CodexSubagentEventRouter(
                sessionId,
                clientSupportsSubagents(this.clientCapabilities),
                new ACPSessionConnection(this.connection, sessionId),
                supportsLodySubagentEvents(this.clientCapabilities),
                childSessionId => this.reportingConnection.reports.releaseOpen(childSessionId),
            ),
            asyncTasks: this.createAsyncTasks(sessionId),
            compactions: new CodexSessionCompactions(),
            toolCallReports: this.reportingConnection.reports,
            openToolCalls: new CodexSessionToolCalls(),
            awaitingClientLoad: operation.kind === "fork",
        };
        if (operation.kind === "new") sessionState.turnUsage = new CodexTurnUsage(true);
        this.installSessionState(sessionState);
        if (operation.kind === "resume") settleTrackerReady(sessionState);
        else this.startCodexTurnTracker(sessionId, Promise.resolve(sessionState));
        this.publishRateLimitsAsync(sessionState);
        subscribed = false;

        const canPublishSessionUpdates = operation.kind !== "fork";
        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            const pendingStartup = this.createPendingMcpStartupSession(
                requestedMcpServers,
                mcpServerStartupVersion,
            );
            if (canPublishSessionUpdates) {
                this.pendingMcpStartupSessions.set(sessionId, pendingStartup);
            }
            const startupAwaitTimeoutMs = parseMcpStartupAwaitTimeoutMs(request._meta);
            if (startupAwaitTimeoutMs !== undefined && startupAwaitTimeoutMs > 0) {
                try {
                    await raceMcpStartupTimeout(pendingStartup.startup, startupAwaitTimeoutMs);
                } catch (err) {
            settleTrackerReady(null);
                    if (this.pendingMcpStartupSessions.get(sessionId) === pendingStartup) {
                        this.pendingMcpStartupSessions.delete(sessionId);
                    }
                    // The session is installed already. A failed wait closes it, so the client never gets a half-open session.
                    await this.closeSession({sessionId}).catch(closeError => {
                        logger.error(`Failed to close session ${sessionId} after a failed MCP startup wait`, closeError);
                    });
                    throw err;
                }
            }
            if (canPublishSessionUpdates) {
                this.publishMcpStartupStatusAsync(sessionId);
            }
        }

        const availableCommands = await this.availableCommands.getAvailableCommands(sessionState);
        if (operation.kind === "resume") {
            this.publishCurrentGoalAsync(sessionState, openedSession.generation);
            this.publishAsyncTasksAsync(sessionState, openedSession.generation);
        }
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState =
            sessionState.agentMode.toSessionModeState(sessionState.clientCapabilities.airClient);

        return [sessionId, sessionModelState, sessionModeState, availableCommands];
    }

    private async getAuthStateForProvider(authProvider: string | null): Promise<ActiveAuthState> {
        if (!this.authProviderUsesOpenAiAccount(authProvider)) {
            await this.publishAuthStatus(authProvider, null);
            return {
                account: null,
                authConfigured: true,
            };
        }
        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        await this.publishAuthStatus(authProvider, accountResponse.account);
        return {
            account: accountResponse.account,
            authConfigured: accountResponse.account !== null || !accountResponse.requiresOpenaiAuth,
        };
    }

    private authProviderUsesOpenAiAccount(authProvider: string | null): boolean {
        return authProvider === null || authProvider === "openai";
    }

    private authProvidersMatch(a: string | null, b: string | null): boolean {
        if (this.authProviderUsesOpenAiAccount(a) && this.authProviderUsesOpenAiAccount(b)) {
            return true;
        }
        return a === b;
    }

    private publishRateLimitsAsync(sessionState: SessionState): void {
        if (
            !sessionState.authConfigured ||
            !this.authProviderUsesOpenAiAccount(sessionState.authProvider)
        ) {
            return;
        }

        void this.codexAcpClient.getRateLimits()
            .then(async response => {
                if (this.sessions.get(sessionState.sessionId) !== sessionState) {
                    return;
                }
                if (!response?.rateLimits) {
                    return;
                }
                const rateLimitsById = Object.values(response.rateLimitsByLimitId ?? {})
                    .filter((snapshot): snapshot is RateLimitSnapshot => snapshot !== undefined);
                const snapshots = rateLimitsById.length > 0
                    ? rateLimitsById
                    : [response.rateLimits];
                const handler = new CodexEventHandler(this.connection, sessionState);
                for (const snapshot of snapshots) {
                    await handler.handleRateLimitsSnapshot(snapshot);
                }
            })
            .catch(err => {
                logger.error(`Failed to read rate limits for session ${sessionState.sessionId}`, err);
            });
    }

    private createAsyncTasks(sessionId: string): CodexBackgroundTerminalTasks {
        return new CodexBackgroundTerminalTasks(
            clientSupportsAirCapability(this.clientCapabilities, AIR_ASYNC_TASKS_KEY),
            sessionId,
            this.codexAcpClient.appServerClient,
            new ACPSessionConnection(this.connection, sessionId),
        );
    }

    private installSessionState(sessionState: SessionState): void {
        this.sessions.get(sessionState.sessionId)?.asyncTasks.clear();
        if (clientSupportsMcpApps(this.clientCapabilities)) sessionState.mcpApps ??= new McpAppCalls();
        this.sessions.set(sessionState.sessionId, sessionState);
    }

    /**
     * Installs a baseline session-scoped subscription, so a Codex-initiated turn starting before
     * any `session/prompt` has run still updates `codexReportedRunningTurnId`, gets its
     * `running`/`idle` states, and renders its items. `prompt()`'s own
     * `subscribeToSessionEvents` call permanently replaces this dispatch
     * (`CodexSubagentSubscriptions.subscribe` keeps a single `current` subscription per session)
     * the first time a prompt runs, and that subscription's own leftover-rendering path takes over
     * from then on; this baseline handler only ever dispatches for a session no prompt has
     * subscribed to yet, so it cannot double-render. It answers approval/elicitation requests
     * exactly like app-server's own default for a thread with no handler registered, so no real
     * prompt has yet run to answer.
     *
     * `ready` lets a resume/load caller register this *before* `thread/resume`/`thread/load` is
     * even sent, so a goal turn Codex auto-starts on the resumed thread within a few ms of the
     * response can't slip in before a handler exists (nothing else buffers dropped notifications).
     * The per-session notification queue (`enqueueSessionNotification`) serializes handler calls,
     * so awaiting `ready` in the first event holds every later event for this session in order;
     * nothing is dropped or reordered. `ready` resolves to the real `SessionState` once install
     * finishes (or `null` on a failed/superseded open, in which case events are silently ignored).
     */
    private startCodexTurnTracker(sessionId: string, ready: Promise<SessionState | null>): void {
        let baselineEventHandler: CodexEventHandler | null = null;
        void this.codexAcpClient.subscribeToSessionEvents(
            sessionId,
            async (event) => {
                const sessionState = await ready;
                if (!sessionState) return;
                if (!baselineEventHandler) {
                    baselineEventHandler = new CodexEventHandler(
                        this.connection,
                        sessionState,
                        clientSupportsTypedSessionFailures(this.clientCapabilities),
                        this.sessionFailureEpoch,
                        sessionState.subagents,
                        (accountUpdated) => this.handleAccountUpdated(accountUpdated),
                        false,
                        clientSupportsCompaction(this.clientCapabilities),
                        clientSupportsNotices(this.clientCapabilities),
                    );
                }
                await this.trackCodexTurnStart(sessionState, event);
                await this.trackSteerLanding(sessionState, event);
                // Codex-started turns carry no `userMessage` item; `handleSessionScopedNotification`
                // already drops that item type, so nothing is synthesized here.
                await baselineEventHandler.handleSessionScopedNotification(event);
                await this.trackCodexTurnCompletion(sessionState, event);
            },
            DENY_ALL_APPROVALS,
            DENY_ALL_ELICITATIONS,
            clientSupportsSubagents(this.clientCapabilities),
            () => {},
            async () => null,
        );
    }

    /**
     * Whether Codex reports a turn currently running on the thread, from `turn/started`/
     * `turn/completed` -- independent of whether a `session/prompt` started it.
     */
    private isCodexTurnRunning(sessionId: string): boolean {
        return this.sessions.get(sessionId)?.codexReportedRunningTurnId != null;
    }

    /**
     * Whether the session is busy enough that a settled permission request should resume
     * `running` rather than leave the client at `requires_action`: either a Codex turn is
     * running, or a v2 prompt is in flight (covers the gap between two Codex turns of the same
     * prompt, e.g. the plan/implementation approval, where no turn has started yet).
     */
    private isSessionBusy(sessionId: string): boolean {
        return this.isCodexTurnRunning(sessionId) || this.v2PromptsInFlight.has(sessionId);
    }

    /**
     * Tracks a Codex-reported turn starting, independent of whether a `session/prompt` started
     * it, and sends `running` for a turn no v2 prompt owns.
     */
    private async trackCodexTurnStart(sessionState: SessionState, event: ServerNotification): Promise<void> {
        if (event.method !== "turn/started" || event.params.threadId !== sessionState.sessionId) {
            return;
        }
        sessionState.codexReportedRunningTurnId = event.params.turn.id;
        await this.reportUnownedTurnState(sessionState.sessionId, {state: "running"});
    }

    /**
     * The other half of `trackCodexTurnStart`: sends exactly one `idle` for a turn no v2 prompt
     * owns, after the notification's own content has already been handled so `idle`
     * stays the last thing sent for the turn.
     */
    private async trackCodexTurnCompletion(sessionState: SessionState, event: ServerNotification): Promise<void> {
        if (event.method !== "turn/completed" || event.params.threadId !== sessionState.sessionId) {
            return;
        }
        if (sessionState.codexReportedRunningTurnId === event.params.turn.id) {
            sessionState.codexReportedRunningTurnId = null;
        }
        await this.reportUnownedTurnState(sessionState.sessionId, {
            state: "idle",
            stopReason: stopReasonForUnownedTurn(event.params.turn.status),
        });
    }

    /**
     * Sends the v2 `state_update` for a Codex-reported turn no `session/prompt` owns. A turn a
     * v2 prompt owns sends its own states already, so this is a no-op while one is in flight for
     * the session; it is also a no-op on v1, which has no `state_update`.
     */
    private async reportUnownedTurnState(sessionId: string, state: acpV2.StateUpdate): Promise<void> {
        if (this.v2PromptsInFlight.has(sessionId)) {
            return;
        }
        const session = new ACPSessionConnection(this.connection, sessionId);
        if (session.protocolVersion !== 2) {
            return;
        }
        try {
            await session.updateState(state);
        } catch (error) {
            logger.error(`Failed to send the '${state.state}' state for session ${sessionId}`, error);
        }
    }

    /**
     * Fails every tool call this session's tracker still has open (a provider restart's
     * dead app-server process never sent `item/completed` for it). No-op if nothing is open, e.g.
     * every item on the cut-off turn already completed before the restart. Runs on v1 and v2
     * alike -- `ACPSessionConnection.update()` renders each accordingly.
     */
    private async finishOutstandingToolCalls(session: SessionState): Promise<void> {
        const updates = session.openToolCalls.finishOutstanding();
        if (updates.length === 0) {
            return;
        }
        const connection = new ACPSessionConnection(this.connection, session.sessionId);
        for (const update of updates) {
            await connection.update(update);
        }
    }

    /**
     * Matches an injected steer's `userMessage` landing against `pendingSteerLandings`, and
     * drops any entries a completed turn never delivered (Codex dropped the steered input
     * silently, so nothing is shown for it). Called from every session-scoped subscription
     * (the baseline one and each prompt's own), so it works whether the steer lands inside a
     * v2-prompt-owned turn or an unowned one.
     */
    private async trackSteerLanding(sessionState: SessionState, event: ServerNotification): Promise<void> {
        if (event.method === "turn/completed" && event.params.threadId === sessionState.sessionId) {
            for (const [clientUserMessageId, entry] of this.pendingSteerLandings) {
                if (entry.sessionId === sessionState.sessionId) {
                    this.pendingSteerLandings.delete(clientUserMessageId);
                }
            }
            return;
        }
        for (const [clientUserMessageId, entry] of this.pendingSteerLandings) {
            if (entry.sessionId === sessionState.sessionId
                && isInsertedUserMessage(event, sessionState.sessionId, clientUserMessageId)) {
                this.pendingSteerLandings.delete(clientUserMessageId);
                await this.emitLiveSteerUserMessage(sessionState.sessionId, clientUserMessageId, entry.prompt);
                return;
            }
        }
    }

    /**
     * Shows a landed steer as a live-only `user_message` (v2 only; the steering response itself
     * carries no `messageId`, per user decision).
     */
    private async emitLiveSteerUserMessage(sessionId: string, messageId: string, prompt: acp.ContentBlock[]): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        if (session.protocolVersion !== 2) {
            return;
        }
        try {
            for (const block of prompt) {
                await session.update(createUserMessageChunk(block, messageId));
            }
        } catch (error) {
            logger.error(`Failed to send the steered user message for session ${sessionId}`, error);
        }
    }

    private getAuthProviderForAuthenticateRequest(request: acp.AuthenticateRequest): string | null {
        if (isCodexAuthRequest(request) && request.methodId === "gateway") {
            return "custom-gateway";
        }
        return null;
    }

    async loadSession(params: acp.LoadSessionRequest): Promise<LegacyLoadSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Loading session...", {sessionId: params.sessionId});
        const {sessionId, modelState, modeState} = await this.loadSessionAndReplayHistory(params);
        const availableCommands = await this.availableCommands.getAvailableCommands(this.getSessionState(sessionId));

        logger.log("Session loaded", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            availableCommands,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async readSessionHistory(
        params: LodyReadSessionHistoryRequest,
    ): Promise<LodyReadSessionHistoryResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Reading session history...", {sessionId: params.sessionId});
        const thread = await this.runWithProcessCheck(
            () => this.codexAcpClient.readSessionHistory(params.sessionId),
        );
        const historyState: HistoryProjectionState = {
            sessionId: params.sessionId,
            sessionTitle: null,
            sessionTitleSource: "unset",
        };
        const session = new ACPSessionConnection(this.connection, params.sessionId);
        await this.publishThreadHistoryTitle(session, historyState, thread, thread.turns.flatMap(turn => turn.items));
        for (const turn of thread.turns) {
            for (const item of turn.items) {
                for (const update of await this.createHistoryUpdates(item, {clientCapabilities: this.capabilities}, turn.id)) {
                    await session.update(update);
                }
            }
        }
        logger.log("Session history read", {sessionId: params.sessionId});
        return {};
    }

    /**
     * Shared by v1 `session/load` and v2 `session/resume` with `replayFrom: {type: "start"}`:
     * reattach, replay retained history as ordinary `session/update`s, then answer.
     */
    private async loadSessionAndReplayHistory(
        params: WithAcpMcpServers<acp.LoadSessionRequest>,
    ): Promise<{
        sessionId: SessionId;
        modelState: LegacySessionModelState;
        modeState: SessionModeState;
    }> {
        const {
            sessionId,
            modelState,
            modeState,
            thread,
            history,
            sessionState,
            settleTrackerReady,
            availableCommands,
        } = await this.getOrCreateSessionWithHistory(params).catch((error: unknown) => {
            this.handleManagedChatgptRefreshError(error);
            this.throwWorkspaceRoutingError(error);
            throw error;
        });

        try {
            try {
                await this.streamThreadHistory(sessionId, thread, history);
            } finally {
                // Only after replay is fully streamed does the baseline tracker start dispatching
                // live events, so a live goal-turn frame can never race ahead of history.
                settleTrackerReady(sessionState);
            }
        } catch (err) {
            // A close during the load already closed the session.
            if (err instanceof SessionClosedDuringLoadError) {
                throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
            }
            // The history pages are read after the session is installed, so a failed read closes the
            // session again. The client never gets a half-open session.
            await this.closeSession({sessionId}).catch(closeError => {
                logger.error(`Failed to close session ${sessionId} after a failed history read`, closeError);
            });
            throw err;
        }
        await this.getSessionState(sessionId).asyncTasks.reconcile();

        this.publishAvailableCommandsAsync(sessionId, availableCommands);
        return {sessionId, modelState, modeState};
    }

    async resumeSession(params: WithAcpMcpServers<acp.ResumeSessionRequest>): Promise<LegacyResumeSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Resuming session...", {sessionId: params.sessionId});
        const [sessionId, modelState, modeState, availableCommands] = await this.getOrCreateSession(params);
        this.publishAvailableCommandsAsync(sessionId, availableCommands);

        logger.log("Session resumed", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });
        return {
            models: modelState,
            modes: modeState,
            availableCommands,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async resumeSessionV2(params: acpV2.ResumeSessionRequest): Promise<acpV2.ResumeSessionResponse> {
        const {replayFrom, ...request} = params;
        if (replayFrom == null) {
            await this.resumeSession(request);
            return this.createSessionConfigOptionsResponseV2(this.getSessionState(params.sessionId));
        }
        if (replayFrom.type !== "start") {
            throw RequestError.invalidParams(undefined, `Unsupported replayFrom type: ${replayFrom.type}`);
        }
        const {sessionId} = await this.loadSessionAndReplayHistory(request);
        return this.createSessionConfigOptionsResponseV2(this.getSessionState(sessionId));
    }

    async forkSession(params: WithAcpMcpServers<acp.ForkSessionRequest>): Promise<acp.ForkSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Forking session...", {sessionId: params.sessionId});
        const [sessionId, , modeState, availableCommands] = await this.getOrForkSession(params);
        this.publishAvailableCommandsAsync(sessionId, availableCommands);

        logger.log("Session forked", {
            sourceSessionId: params.sessionId,
            sessionId,
        });
        return {
            sessionId,
            modes: modeState,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    async forkSessionV2(params: acpV2.ForkSessionRequest): Promise<acpV2.ForkSessionResponse> {
        const {sessionId} = await this.forkSession(params);
        return {
            sessionId,
            ...this.createSessionConfigOptionsResponseV2(this.getSessionState(sessionId)),
        };
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        logger.log("Listing sessions...", {cwd: params.cwd, cursor: params.cursor});
        await this.checkAuthorization();
        const response = await this.runWithProcessCheck(() => this.codexAcpClient.listSessions(params));
        return {
            ...response,
            sessions: response.sessions.map((session) => {
                const activeSession = this.sessions.get(session.sessionId);
                if (!activeSession || activeSession.additionalDirectories.length === 0) {
                    return session;
                }
                return {
                    ...session,
                    additionalDirectories: activeSession.additionalDirectories,
                };
            }),
        };
    }

    async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
        logger.log("Closing session...", {sessionId: params.sessionId});
        const closeGeneration = this.bumpSessionGeneration(params.sessionId);
        const sessionState = this.sessions.get(params.sessionId);
        this.beginSessionCloseFence(params.sessionId);

        try {
            // Same as `session/cancel`: drop every v2 prompt still queued for this session first.
            this.cancelQueuedV2Prompts(params.sessionId);
            if (sessionState) {
                await this.interruptSessionTurn(sessionState, "Close", true);
                sessionState.asyncTasks.clear();
            } else {
                logger.log("Close request received for unknown local session", {sessionId: params.sessionId});
            }

            const activePrompt = this.activePrompts.get(params.sessionId);
            if (activePrompt) {
                activePrompt.requestClose();
                await activePrompt.completion;
            }

            await this.runWithProcessCheck(() => this.codexAcpClient.closeSession(params.sessionId));
            logger.log("Session closed", {sessionId: params.sessionId});
        } finally {
            if (this.getSessionGeneration(params.sessionId) === closeGeneration) {
                this.sessions.delete(params.sessionId);
                this.pendingMcpStartupSessions.delete(params.sessionId);
                this.pendingTurnStarts.delete(params.sessionId);
                this.activePrompts.delete(params.sessionId);
                this.pendingSteers.delete(params.sessionId);
                this.turnStartQueueTail.delete(params.sessionId);
                this.queuedV2PromptCancellers.delete(params.sessionId);
                this.steeringQueues.delete(params.sessionId);
            }
            this.endSessionCloseFence(params.sessionId);
        }

        return {};
    }

    async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
        logger.log("Deleting session...", {sessionId: params.sessionId});
        const sessionId = params.sessionId;
        const shouldCloseLocalSession = this.hasLocalSession(sessionId);

        this.beginSessionCloseFence(sessionId);
        try {
            if (shouldCloseLocalSession) {
                await this.closeSession({sessionId});
            } else {
                this.bumpSessionGeneration(sessionId);
            }

            await this.runWithProcessCheck(() => this.codexAcpClient.deleteSession(sessionId));
            logger.log("Session deleted", {sessionId});
        } finally {
            this.endSessionCloseFence(sessionId);
        }

        return {};
    }

    private hasLocalSession(sessionId: string): boolean {
        return this.sessions.has(sessionId)
            || this.pendingMcpStartupSessions.has(sessionId)
            || this.pendingTurnStarts.has(sessionId)
            || this.activePrompts.has(sessionId)
            || this.hasPendingSessionOpen(sessionId)
            || this.sessionIsClosing(sessionId);
    }

    private hasPendingSessionOpen(sessionId: string): boolean {
        return this.sessionOpenGenerations.get(sessionId) === this.getSessionGeneration(sessionId);
    }

    async newSession(
        params: WithAcpMcpServers<acp.NewSessionRequest>,
    ): Promise<LegacyNewSessionResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        logger.log("Starting new session...");
        const [sessionId, modelState, modeState, availableCommands] = await this.getOrCreateSession(params);
        this.publishAvailableCommandsAsync(sessionId, availableCommands);

        logger.log("New session created", {
            sessionId: sessionId,
            modelId: modelState.currentModelId,
            availableModelCount: modelState.availableModels.length
        });

        return {
            sessionId: sessionId,
            models: modelState,
            modes: modeState,
            availableCommands,
            ...this.createSessionConfigOptionsResponse(this.getSessionState(sessionId)),
        };
    }

    private publishAvailableCommandsAsync(
        sessionId: SessionId,
        availableCommands: acp.AvailableCommand[]
    ): void {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) return;
        const sessionGeneration = this.getSessionGeneration(sessionId);
        setTimeout(() => {
            const shouldPublish = () => this.sessionPublishIsCurrent(sessionState, sessionGeneration);
            if (!shouldPublish()) return;
            void this.availableCommands.publish(sessionState, availableCommands, shouldPublish).catch(err => {
                logger.error(`Failed to publish available commands for session ${sessionId}`, err);
            });
        }, 0);
    }

    async newSessionV2(params: acpV2.NewSessionRequest): Promise<acpV2.NewSessionResponse> {
        const {sessionId} = await this.newSession(params);
        return {
            sessionId,
            ...this.createSessionConfigOptionsResponseV2(this.getSessionState(sessionId)),
        };
    }

    async authenticate(
        _params: acp.AuthenticateRequest,
        requestId?: acp.JsonRpcId,
    ): Promise<acp.AuthenticateResponse> {
        logger.log("Authenticate request received");
        const elicitationRequester = this.createUrlElicitationRequester(requestId);
        const isAuthenticated = await this.runWithProcessCheck(() => this.codexAcpClient.authenticate(_params, elicitationRequester));
        if (!isAuthenticated) {
            logger.log("Authenticate request failed");
            throw RequestError.invalidParams();
        }
        await this.refreshAuthState(this.getAuthProviderForAuthenticateRequest(_params));
        logger.log("Authenticate request completed");
        return { };
    }

    private createUrlElicitationRequester(requestId?: acp.JsonRpcId): UrlElicitationRequester | undefined {
        if (requestId == null || !clientSupportsUrlElicitation(this.clientCapabilities)) {
            return undefined;
        }
        let elicitationId: string | null = null;
        return {
            elicitUrl: (request) => {
                elicitationId = request.elicitationId;
                return this.connection.request(acp.methods.client.elicitation.create, {
                    mode: "url",
                    requestId,
                    ...request,
                });
            },
            completeElicitation: async () => {
                if (elicitationId === null) {
                    return;
                }
                await this.connection.notify(acp.methods.client.elicitation.complete, {
                    elicitationId,
                });
            },
        };
    }

    async logout(_params: acp.LogoutRequest): Promise<void> {
        logger.log("Logout request received");
        await this.runWithProcessCheck(() => this.codexAcpClient.logout());
        await this.refreshAuthState(null);
        logger.log("Logout request completed");
    }

    /** v2 `auth/login`: same params as v1 `authenticate`, only the method name changed. */
    async authenticateV2(
        params: acpV2.LoginAuthRequest,
        requestId?: acpV2.JsonRpcId,
    ): Promise<acpV2.LoginAuthResponse> {
        return await this.authenticate(params, requestId);
    }

    /** v2 `auth/logout`: same params as v1 `logout`, only the method name changed. */
    async logoutV2(params: acpV2.LogoutAuthRequest): Promise<acpV2.LogoutAuthResponse> {
        await this.logout(params);
        return {};
    }

    listProviders(_params: acp.ListProvidersRequest): acp.ListProvidersResponse {
        return { providers: this.codexAcpClient.listProviders() };
    }

    async setProvider(params: acp.SetProviderRequest): Promise<acp.SetProviderResponse> {
        this.codexAcpClient.setProvider(params);
        await this.enqueueProviderUpdate((client) => client.setProvider(params));
        return { };
    }

    async disableProvider(params: acp.DisableProviderRequest): Promise<acp.DisableProviderResponse> {
        this.codexAcpClient.disableProvider(params);
        if (params.providerId !== OPENAI_PROVIDER_ID) {
            return { };
        }
        await this.enqueueProviderUpdate((client) => client.disableProvider(params));
        return { };
    }

    private async enqueueProviderUpdate(apply: (client: CodexAcpClient) => void): Promise<void> {
        const previous = this.providerUpdate?.catch(() => undefined) ?? Promise.resolve();
        const update = previous.then(async () => {
            if (this.sessions.size === 0) {
                return;
            }

            const activePrompts = [...this.activePrompts.values()].map(prompt => prompt.completion);
            if (activePrompts.length > 0) {
                logger.log("Waiting for active prompts before provider restart", {count: activePrompts.length});
                await Promise.all(activePrompts);
            }

            logger.log("Restarting Codex app-server for provider update", {sessionCount: this.sessions.size});
            for (const session of this.sessions.values()) {
                session.asyncTasks.prepareForAppServerReplacement();
            }
            await this.finishAllAsyncTasks("stopped", "before the provider restart");
            const replacement = await this.restartCodexClient();
            // Captured before the swap: draining its per-session queues below (after the process
            // it wraps has already exited) is how a turn left running on the old client gets
            // closed out, since the old process's EOF drops the notification and no
            // `turn/completed` ever arrives for it.
            const previousClient = this.codexAcpClient;
            apply(replacement);
            if (this.initializeRequest === null) {
                throw new Error("Cannot restart Codex app-server before ACP initialization");
            }
            await replacement.initialize(this.initializeRequest);
            this.codexAcpClient = replacement;
            this.availableCommands = this.createAvailableCommands(replacement);

            const resumeErrors: unknown[] = [];
            for (const session of this.sessions.values()) {
                if (session.awaitingClientLoad) {
                    // A fork the client hasn't loaded yet: leave it unsubscribed, matching the
                    // fork design rather than pulling it into the new app-server.
                    continue;
                }

                // v2 only: a turn still running when the old process was killed never gets its
                // `turn/completed` -- the old process's EOF just drops the notification -- which
                // would otherwise leave the session wedged at `running` forever (an R13 MUST
                // violation) and `isSessionBusy` stuck true. Drain the old client's queue first so
                // an already-buffered `turn/completed` still clears this normally; only a turn
                // genuinely orphaned by the restart gets force-closed. No-op on v1 (no state
                // channel) and while a v2 prompt is in flight for the session (its own `idle`
                // closes the state). This must happen before this session's tracker is registered
                // and it's resumed: Codex can auto-start a continuation turn within a few ms of
                // `thread/resume`'s response, and that turn's own `running` would otherwise be
                // mistaken for the cut-off one and cancelled instead.
                await previousClient.waitForSessionNotifications(session.sessionId);
                if (session.codexReportedRunningTurnId !== null) {
                    session.codexReportedRunningTurnId = null;
                    // the dead process's EOF drops `item/completed` for anything still open on
                    // the cut-off turn (v1 + v2), leaving the client with a spinner forever. Fail
                    // those tool calls -- and end their terminals -- before the turn's own
                    // idle/cancelled close-out below.
                    await this.finishOutstandingToolCalls(session);
                    await this.reportUnownedTurnState(session.sessionId, {state: "idle", stopReason: "cancelled"});
                }

                session.asyncTasks.setAppServer(replacement.appServerClient);
                // Registered before `resumeSession`, so a goal turn Codex auto-starts within a
                // few ms of `thread/resume`'s response can't slip past an empty subscription
                // registry on the new client (10(f1) `startCodexTurnTracker`).
                const [trackerReady, settleTrackerReady] = createDeferred<SessionState | null>();
                this.startCodexTurnTracker(session.sessionId, trackerReady);
                try {
                    // FIXME: a session that was created but never had its first turn has no
                    // rollout on disk yet, so `thread/resume` fails ("no rollout found for thread
                    // id ..."), the `thread/read` fallback below fails too ("thread not loaded"),
                    // and this provider restart leaves the session dead: any later
                    // `session/prompt` for it fails with "thread not found".
                    await replacement.resumeSession({
                        sessionId: session.sessionId,
                        cwd: session.cwd,
                        additionalDirectories: session.additionalDirectories,
                        mcpServers: session.mcpServers ?? [],
                    });
                    session.authProvider = replacement.getModelProvider();
                    session.asyncTasks.refresh();
                    settleTrackerReady(session);
                    logger.log("Resumed session after provider restart", {sessionId: session.sessionId});
                } catch (error) {
                    settleTrackerReady(null);
                    resumeErrors.push(error);
                    logger.error(`Failed to resume session ${session.sessionId} after provider restart`, error);
                }
            }

            if (resumeErrors.length > 0) {
                throw new AggregateError(resumeErrors, `Failed to resume ${resumeErrors.length} session(s) after provider restart`);
            }
        });
        this.providerUpdate = update;
        try {
            await update;
        } finally {
            if (this.providerUpdate === update) {
                this.providerUpdate = null;
            }
        }
    }

    private captureStderr(): void {
        const state = this.codexProcessState;
        if (state === null || state.stderrProcess === state.connection.process) {
            return;
        }
        state.stderrProcess = state.connection.process;
        state.connection.process.stderr.addListener("data", (data: Buffer) => {
            state.stderr = (state.stderr + data.toString()).slice(-2 * 1024);
        });
    }

    private observeCodexProcess(): void {
        const process = this.codexProcessState?.connection.process;
        if (!process) return;
        const generation = ++this.codexProcessGeneration;
        process.once("exit", () => {
            if (generation !== this.codexProcessGeneration) return;
            void this.finishAllAsyncTasks("failed", "after the Codex process exited");
        });
    }

    private async restartCodexClient(): Promise<CodexAcpClient> {
        const state = this.codexProcessState;
        if (state === null) {
            throw new Error("Codex process state is unavailable");
        }

        const previous = state.connection;
        this.codexProcessGeneration += 1;
        const exited = previous.process.exitCode === null
            ? once(previous.process, "exit")
            : Promise.resolve();
        previous.process.stdin.end();
        const forceKill = setTimeout(() => {
            if (previous.process.exitCode === null) {
                logger.log("Codex still running 2s after provider restart; terminating process");
                previous.process.kill();
            }
        }, 2000);
        await exited;
        clearTimeout(forceKill);

        state.stderr = "";
        state.connection = startCodexConnection(state.codexPath);
        this.captureStderr();
        this.observeCodexProcess();
        return new CodexAcpClient(
            new CodexAppServerClient(state.connection.connection),
            state.config,
            state.modelProvider,
        );
    }

    /** Returns whether the auth state was read (and thus the auth status pushed). */
    private async refreshSessionsAuthState(authProvider: string | null): Promise<boolean> {
        if (this.sessions.size === 0) return false;

        const sessionsToRefresh = [...this.sessions.values()]
            .filter(sessionState => this.authProvidersMatch(sessionState.authProvider, authProvider));
        if (sessionsToRefresh.length === 0) return false;

        const authState = await this.getAuthStateForProvider(authProvider);
        for (const sessionState of sessionsToRefresh) {
            sessionState.account = authState.account;
            sessionState.authConfigured = authState.authConfigured;
            this.publishRateLimitsAsync(sessionState);
        }
        return true;
    }

    /**
     * Refreshes the sessions of a provider and makes sure the connection-level
     * `authStatus` is pushed even when no session matched (the empty-screen
     * login case). Reuses the session refresh read; never adds a second one.
     */
    private async refreshAuthState(authProvider: string | null): Promise<void> {
        const refreshed = await this.refreshSessionsAuthState(authProvider);
        if (refreshed) return;
        try {
            // Only the push matters here: there is no session for the auth state to land in.
            await this.getAuthStateForProvider(authProvider ?? this.codexAcpClient.getModelProvider());
        } catch (error) {
            logger.log("Failed to refresh auth status", {error: String(error)});
        }
    }

    /**
     * Schedules the connection's first `_auth/status_update`: one account read,
     * pushed whatever it says, including `none`.
     *
     * The push must not overtake the `initialize` response. The JSON-RPC layer
     * writes that response in the microtask that resolves {@link initialize}, so
     * the read starts from a check-phase callback, which always runs after it.
     * `initialize` itself never waits for the read.
     *
     * "Unconditional" costs nothing extra here: nothing has been pushed yet on
     * this connection, so {@link setAuthStatus} cannot suppress this one.
     */
    private publishFirstAuthStatusAfterResponse(): void {
        setImmediate(() => void this.publishAuthStatusRead());
    }

    /**
     * Reads the agent-owned identity and pushes it.
     *
     * Never rejects: an unreadable source means "nothing to report", not an
     * error. The client then keeps showing the last pushed value, or "not
     * reported" when there was none.
     */
    private async publishAuthStatusRead(): Promise<void> {
        let authStatus: AuthStatus;
        try {
            authStatus = await this.readAgentAuthIdentity();
        } catch (error) {
            logger.log("Cannot determine auth status", {error: String(error)});
            return;
        }
        await this.setAuthStatus(authStatus);
    }

    /**
     * Builds the agent-owned auth identity. Routing the client configured
     * through the ACP `providers/*` API is invisible here: the reported state
     * is what the agent itself is logged in with. `gateway` stays reserved for
     * agent-owned gateway state — the `gateway` auth method, or a provider the
     * user configured in Codex's own config.
     */
    private async readAgentAuthIdentity(): Promise<AuthStatus> {
        const authGatewayName = this.codexAcpClient.getAuthGatewayProviderName();
        if (authGatewayName !== null) {
            return gatewayStatus(authGatewayName);
        }
        const modelProvider = await this.runWithProcessCheck(() => this.codexAcpClient.getAgentConfiguredModelProvider());
        if (!this.authProviderUsesOpenAiAccount(modelProvider)) {
            return gatewayStatus(modelProvider);
        }
        const accountResponse = await this.runWithProcessCheck(() => this.codexAcpClient.getAccount());
        return fromAccount(accountResponse.account);
    }

    /**
     * Pushes `_auth/status_update` for the freshly read account of a provider.
     * Agent-owned gateway authentication wins; a client-driven provider
     * override is ignored and the agent-owned login is reported instead.
     */
    private async publishAuthStatus(
        authProvider: string | null,
        account: Account | null,
    ): Promise<void> {
        const authGatewayName = this.codexAcpClient.getAuthGatewayProviderName();
        if (authGatewayName !== null) {
            await this.setAuthStatus(gatewayStatus(authGatewayName));
            return;
        }
        if (this.authProviderUsesOpenAiAccount(authProvider)) {
            await this.setAuthStatus(fromAccount(account));
            return;
        }
        if (this.codexAcpClient.isClientConfiguredProvider(authProvider)) {
            // The session routes through client-configured providers; the agent-owned
            // login is a separate question, so read it instead of reporting the
            // override. A failed read means "nothing to report" — it must never
            // take the session create down with it.
            await this.publishAuthStatusRead();
            return;
        }
        await this.setAuthStatus(gatewayStatus(authProvider));
    }

    /**
     * Handles the app-server `account/updated` push: the free freshness channel
     * for logins and logouts happening outside this connection.
     */
    handleAccountUpdated(notification: AccountUpdatedNotification): void {
        void this.applyAccountUpdated(notification);
    }

    /**
     * `account/updated` describes the Codex account only. It must never
     * overwrite an agent-owned gateway status, which no account event can
     * invalidate; only a gateway logout or a provider change does.
     */
    private async applyAccountUpdated(notification: AccountUpdatedNotification): Promise<void> {
        try {
            if (this.codexAcpClient.getAuthGatewayProviderName() !== null) {
                return;
            }
            if (this.currentAuthStatus === null) {
                // Nothing pushed yet, so the account event alone cannot tell whether
                // the agent routes through its own gateway config: read the full state.
                await this.publishAuthStatusRead();
                return;
            }
            if (this.currentAuthStatus.kind === "gateway") {
                return;
            }
            await this.setAuthStatus(fromAccountUpdated(notification, this.currentAuthStatus));
        } catch (error) {
            logger.log("Failed to apply account update to auth status", {error: String(error)});
        }
    }

    /**
     * Stores `next` and pushes `_auth/status_update`.
     *
     * A push goes out only when the payload changed. The identity is read on
     * many occasions — `initialize`, each session create, each `account/updated`
     * — and almost all of them see the login already reported.
     * Clients replace their whole state on each update and tolerate duplicates,
     * so a repeat is harmless, but it is pure noise all the same.
     *
     * The first push of a connection always goes out: nothing was reported yet,
     * so no payload can equal it.
     */
    private async setAuthStatus(next: AuthStatus): Promise<void> {
        if (sameAuthStatus(this.currentAuthStatus, next)) {
            return;
        }
        this.currentAuthStatus = next;
        try {
            await this.connection.notify(AUTH_STATUS_UPDATE_METHOD, {authStatus: next});
        } catch (error) {
            logger.log("Failed to send auth status update", {error: String(error)});
        }
    }

    async setSessionMode(
        _params: acp.SetSessionModeRequest,
    ): Promise<acp.SetSessionModeResponse> {
        logger.log("Set session mode requested", {
            sessionId: _params.sessionId,
            modeId: _params.modeId
        });
        const sessionState = this.sessions.get(_params.sessionId);
        if (!sessionState) throw new Error(`Session ${_params.sessionId} not found`);

        this.applyModeChange(sessionState, _params.modeId);
        return {};
    }

    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        logger.log("Set session config option requested", {
            sessionId: params.sessionId,
            configId: params.configId,
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        await this.applySessionConfigOption(sessionState, params);

        return {
            configOptions: this.createSessionConfigOptions(sessionState),
        };
    }

    async setSessionConfigOptionV2(
        params: acpV2.SetSessionConfigOptionRequest,
    ): Promise<acpV2.SetSessionConfigOptionResponse> {
        const response = await this.setSessionConfigOption(toV1SetSessionConfigOptionRequest(params));
        return {configOptions: toV2ConfigOptions(response.configOptions)};
    }

    private async applySessionConfigOption(sessionState: SessionState, params: acp.SetSessionConfigOptionRequest): Promise<void> {
        switch (params.configId) {
            case FAST_MODE_CONFIG_ID:
                this.applyFastModeChange(sessionState, params);
                break;
            case MODE_CONFIG_ID:
                this.applyModeChange(sessionState, this.stringConfigValue(params));
                break;
            case LODY_PLAN_MODE_CONFIG_ID:
                if (typeof params.value !== "boolean") throw RequestError.invalidParams();
                await this.applyCollaborationModeChange(sessionState, params.value ? PLAN_COLLABORATION_MODE : DEFAULT_COLLABORATION_MODE);
                break;
            case MODEL_CONFIG_ID:
                this.applyModelChange(sessionState, this.stringConfigValue(params));
                break;
            case REASONING_EFFORT_CONFIG_ID:
                this.applyReasoningEffortChange(sessionState, this.stringConfigValue(params));
                break;
            default:
                throw RequestError.invalidParams();
        }
    }

    private applyFastModeChange(sessionState: SessionState, params: Omit<acp.SetSessionConfigOptionRequest, "value"> & { value: string | boolean }): void {
        const value = params.value;
        if (typeof value === "boolean") {
            sessionState.fastModeEnabled = value;
            return;
        }
        if (value !== FAST_MODE_ON && value !== FAST_MODE_OFF) {
            throw RequestError.invalidParams();
        }
        sessionState.fastModeEnabled = value === FAST_MODE_ON;
    }

    private stringConfigValue(params: { value: string | boolean }): string {
        if (typeof params.value !== "string") {
            throw RequestError.invalidParams();
        }
        return params.value;
    }

    private applyModeChange(sessionState: SessionState, value: string): void {
        const newMode = AgentMode.find(value);
        if (!newMode) {
            throw RequestError.invalidParams();
        }
        sessionState.agentMode = newMode;
    }

    private async applyCollaborationModeChange(sessionState: SessionState, value: string): Promise<void> {
        const mode = parseCollaborationMode(value);
        if (mode === null) {
            throw RequestError.invalidParams();
        }
        await this.codexAcpClient.setCollaborationMode(sessionState.sessionId, mode, sessionState.currentModelId);
        sessionState.collaborationMode = mode;
    }

    private applyModelChange(sessionState: SessionState, value: string): void {
        const model = sessionState.availableModels.find(m => m.id === value);
        if (!model) {
            const currentModel = ModelId.fromString(sessionState.currentModelId).model;
            if (value === currentModel) {
                return;
            }
            throw RequestError.invalidParams();
        }
        const currentEffort = ModelId.fromString(sessionState.currentModelId).effort;
        const effort = findSupportedEffort(model.supportedReasoningEfforts, currentEffort)
            ?? model.defaultReasoningEffort;
        this.applyModelAndEffort(sessionState, model, effort);
    }

    private applyReasoningEffortChange(sessionState: SessionState, value: string): void {
        const effort = findSupportedEffort(sessionState.supportedReasoningEfforts, value);
        if (!effort) {
            throw RequestError.invalidParams();
        }
        const {model} = ModelId.fromString(sessionState.currentModelId);
        sessionState.currentModelId = ModelId.create(model, effort).toString();
    }

    private applyModelAndEffort(sessionState: SessionState, model: Model, effort: ReasoningEffort): void {
        sessionState.currentModelId = ModelId.fromComponents(model, effort).toString();
        sessionState.supportedReasoningEfforts = model.supportedReasoningEfforts;
        sessionState.supportedInputModalities = model.inputModalities;
        sessionState.currentModelSupportsFast = modelSupportsFast(model);
    }

    async unstable_setSessionModel(params: LegacySetSessionModelRequest): Promise<LegacySetSessionModelResponse> {
        logger.log("Set session model requested", {
            sessionId: params.sessionId,
            modelId: params.modelId
        });
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) throw new Error(`Session ${params.sessionId} not found`);

        const {model: requestedModelName, effort: requestedEffort} = ModelId.fromString(params.modelId);

        const models = await this.codexAcpClient.fetchAvailableModels();
        const model = models.find(m => m.id === requestedModelName);
        if (!model) throw new Error(`Unknown model ${params.modelId}`);

        let reasoningEffort: ReasoningEffort;
        if (requestedEffort) {
            const matchedEffort = findSupportedEffort(model.supportedReasoningEfforts, requestedEffort);
            if (!matchedEffort) {
                throw new Error(`Unsupported reasoning effort ${requestedEffort} for model ${requestedModelName}`);
            }
            reasoningEffort = matchedEffort;
        } else {
            reasoningEffort = model.defaultReasoningEffort;
        }

        sessionState.availableModels = models;
        this.applyModelAndEffort(sessionState, model, reasoningEffort);

        return {};
    }

    private parseLegacySetSessionModelParams(params: Record<string, unknown>): LegacySetSessionModelRequest {
        const sessionId = params["sessionId"];
        const modelId = params["modelId"];
        if (typeof sessionId !== "string" || typeof modelId !== "string") {
            throw RequestError.invalidParams();
        }
        return {
            sessionId: sessionId,
            modelId: modelId,
        };
    }

    /**
     * Handles one incoming steering request, serialising it against any other
     * steer already in flight for the same session.
     *
     * Every session gets its own {@link SteeringQueue}: the request is enqueued
     * and awaited, so concurrent steers for one session run strictly one at a
     * time, in arrival order, and can never race to inject into rival turns.
     * Steers for different sessions use different queues and run
     * concurrently. Once the queue drains to idle it is removed from the map,
     * so no per-session entry leaks after the session goes quiet (the identity
     * check guards against deleting a queue a later request has since reused).
     *
     * @param params The target session id and the prompt to steer with.
     * @returns Whether the prompt joined the active turn or could not be applied.
     */
    async executeOrQueueSteeringRequest(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        const queue = this.getSteeringQueue(params.sessionId);
        try {
            return await queue.enqueue(params);
        } catch (error) {
            if (error instanceof RequestError) {
                throw error;
            }
            logger.error(`Steering request for session ${params.sessionId} failed`, error);
            // Only an explicit refusal authorizes ordinary-prompt replay.
            // An unexpected adapter failure cannot prove
            // whether app-server accepted the steer, so preserve that
            // ambiguity by rejecting the request instead.
            throw error;
        } finally {
            if (queue.isIdle && this.steeringQueues.get(params.sessionId) === queue) {
                this.steeringQueues.delete(params.sessionId);
            }
        }
    }

    /**
     * Returns the steering queue for a session, creating and registering it on
     * first use.
     *
     * @param sessionId The session whose steering queue is required.
     * @returns The session's existing queue, or a freshly created one.
     */
    private getSteeringQueue(sessionId: string): SteeringQueue {
        let queue = this.steeringQueues.get(sessionId);
        if (!queue) {
            queue = new SteeringQueue((params) => this.performSteeringRequest(params));
            this.steeringQueues.set(sessionId, queue);
        }
        return queue;
    }

    /**
     * Delivers a steering prompt to the currently active turn.
     *
     * @param params The target session id and the prompt to steer with.
     * @returns "injected" when the prompt joined the active turn.
     */
    private async performSteeringRequest(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        logger.log("Steering session requested", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        this.assertSteerInputSupported(params, sessionState);

        const turnId = await this.getSteerableTurnId(sessionState);
        if (turnId) {
            const injected = await this.injectSteerIntoActiveTurn(params, turnId);
            if (injected) {
                logger.log("Steering session injected", {sessionId: params.sessionId, turnId});
                return {outcome: "injected"};
            }
        }
        throw RequestError.invalidRequest("No active Codex turn to steer");
    }

    /**
     * Rejects a steering prompt whose content the active model cannot accept
     * (currently: image blocks on a text-only model).
     */
    private assertSteerInputSupported(params: SessionSteerRequest, sessionState: SessionState): void {
        const hasImage = params.prompt.some(block => block.type === "image");
        if (hasImage && !sessionState.supportedInputModalities.includes("image")) {
            throw RequestError.invalidRequest("The current model does not support image input");
        }
    }

    /**
     * Attempts to inject the prompt into the given running turn.
     *
     * After submission, only an explicit refusal proves non-delivery. A turn
     * ending (including Stop) does not prove whether it consumed the input.
     */
    private async injectSteerIntoActiveTurn(
        params: SessionSteerRequest,
        turnId: string,
    ): Promise<boolean> {
        const activePrompt = this.activePrompts.get(params.sessionId);
        const activeTurn = activePrompt?.currentTurn;
        const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
        if (firstText.startsWith("/")) {
            throw RequestError.invalidRequest("Slash commands cannot steer an active Codex turn");
        }
        if (
            !activePrompt
            || !activeTurn
            || activeTurn.turnId !== turnId
            || activePrompt.signal.aborted
        ) {
            return false;
        }

        const pending = this.pendingSteers.get(params.sessionId) ?? new Map<string, PendingSteer>();
        if (pending.has(params.steerId)) {
            throw RequestError.invalidRequest(`Duplicate Codex steer id: ${params.steerId}`);
        }
        let resolveApplied: () => void = () => {};
        const applied = new Promise<void>(resolve => { resolveApplied = resolve; });
        const steer: PendingSteer = {
            activePrompt, threadId: activeTurn.threadId, turnId,
            requestPending: true, acknowledgement: null, applied, resolveApplied,
        };
        pending.set(params.steerId, steer);
        this.pendingSteers.set(params.sessionId, pending);

        let requestAccepted = false;
        try {
            const response = await this.runWithProcessCheck(() => this.codexAcpClient.steerTurn({
                threadId: activeTurn.threadId,
                turnId,
                prompt: params.prompt,
                steerId: params.steerId,
            }));
            if (response.turnId !== turnId) {
                throw RequestError.internalError(
                    {expectedTurnId: turnId, actualTurnId: response.turnId},
                    `Codex steered unexpected turn ${response.turnId}; expected ${turnId}`,
                );
            }
            requestAccepted = true;
            return true;
        } catch (err) {
            const refused = this.isNoActiveTurnToSteerError(err);
            if (await this.reconcileSteer(params, steer, !refused)) {
                await this.acknowledgeSteer(params.sessionId, params.steerId, steer);
                return true;
            }
            if (refused) return false;
            throw err;
        } finally {
            steer.requestPending = false;
            if (!requestAccepted || this.activePrompts.get(params.sessionId) !== activePrompt) {
                this.removePendingSteer(params.sessionId, params.steerId, steer);
            }
        }
    }

    private async reconcileSteer(
        params: SessionSteerRequest,
        steer: PendingSteer,
        readHistory: boolean,
    ): Promise<boolean> {
        let finished = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            // This drains received notifications, not the transport or rollout
            // store. Missing history therefore cannot establish non-delivery.
            const historyApplied = (async () => {
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                if (steer.acknowledgement !== null) return true;
                if (finished || !readHistory) return false;
                const thread = await this.codexAcpClient.readSessionHistory(steer.threadId);
                return thread.id === steer.threadId && thread.turns.some(turn =>
                    turn.id === steer.turnId && turn.items.some(item =>
                        item.type === "userMessage" && item.clientId === params.steerId));
            })().catch(error => {
                logger.error("Could not reconcile Codex steer history", error);
                return false;
            });
            return await Promise.race([
                historyApplied,
                steer.applied.then(() => true),
                new Promise<false>(resolve => {
                    timeout = setTimeout(() => resolve(false), 5_000);
                    timeout.unref?.();
                }),
            ]) || steer.acknowledgement !== null;
        } finally {
            // Late read results are read-only: never acknowledge after the host
            // has already received an unknown-delivery error.
            finished = true;
            clearTimeout(timeout);
        }
    }


    private async startNewTurnFromExternalPrompt(
        params: acp.PromptRequest,
        source: string,
        canStart: () => Promise<boolean> = async () => true,
        insertion?: UserMessageInsertion,
    ): Promise<boolean> {
        // Takes this session's place in the shared turn-start FIFO before anything else runs, so
        // no other starter can begin between this check and the turn actually starting. This
        // hands the reservation to `prompt()` below rather than letting it self-acquire one, so
        // it releases only once `prompt()` truly finishes (not when this function's own steer
        // promise resolves early, on the "a turn was started" success path).
        const reservation = this.acquireTurnStartReservation(params.sessionId);
        if (reservation.needsWait) {
            await reservation.wait;
        }
        if (this.sessionIsClosing(params.sessionId)) {
            reservation.release();
            throw RequestError.invalidRequest(`Session ${params.sessionId} is closing`);
        }
        if (!await canStart()) {
            reservation.release();
            return false;
        }

        return await new Promise<boolean>((resolve, reject) => {
            let turnStarted = false;
            const promptDone = this.prompt(params, undefined, () => {
                turnStarted = true;
                logger.log(`${source} started a new turn`, {sessionId: params.sessionId});
                // The new turn is now running. This is the success path: answer the
                // steer immediately ("a turn was started") and let prompt() finish the
                // turn in the background.
                resolve(true);
            }, insertion, reservation);
            void promptDone.finally(() => reservation.release());
            promptDone.then(
                (response) => {
                    if (!turnStarted && response.stopReason === "cancelled") {
                        // The prompt ended without the turn ever starting, because it
                        // was cancelled. The steer never took, so fail the request.
                        reject(RequestError.invalidRequest(`Session ${params.sessionId} was cancelled before the steering turn started`));
                    } else {
                        // Either the turn already started (this is a no-op after the
                        // resolve in the callback above), or the prompt finished
                        // without ever starting a turn and was not cancelled (e.g. a
                        // command-only turn). Both count as a successfully accepted steer.
                        resolve(turnStarted);
                    }
                },
                (error: unknown) => {
                    if (turnStarted) {
                        // The turn had already started, so the steer was already
                        // answered "startedNewTurn". This is a failure of a turn running
                        // in the background — nothing to return, just log it.
                        logger.error(`${source} prompt for session ${params.sessionId} failed`, error);
                    } else {
                        // The prompt failed before the turn started. The steer never
                        // took, so surface the failure to the caller.
                        reject(error);
                    }
                },
            );
        });
    }

    private isNoActiveTurnToSteerError(error: unknown): boolean {
        const messages = error instanceof Error ? [error.message] : [];
        if (typeof error === "object" && error !== null && "data" in error) {
            const data = (error as {data?: unknown}).data;
            if (typeof data === "string") {
                messages.push(data);
            } else if (typeof data === "object" && data !== null && "details" in data) {
                const details = (data as {details?: unknown}).details;
                if (typeof details === "string") {
                    messages.push(details);
                }
            }
        }
        return messages.some(message => message.toLowerCase().includes("no active turn to steer"));
    }

    private async getSteerableTurnId(sessionState: SessionState): Promise<string | null> {
        if (this.sessionIsClosing(sessionState.sessionId)) {
            return null;
        }
        if (sessionState.currentTurnId) {
            return codexRunningTurnId(sessionState, sessionState.currentTurnId);
        }

        const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
        if (!pendingTurnStart) {
            return null;
        }
        return await pendingTurnStart.promise;
    }

    private parseSessionSteerParams(params: Record<string, unknown>): SessionSteerRequest {
        const sessionId = params["sessionId"];
        const prompt = params["prompt"];
        const steerId = params["steerId"];
        if (
            typeof sessionId !== "string"
            || !Array.isArray(prompt)
            || typeof steerId !== "string"
            || steerId.length === 0
        ) {
            throw RequestError.invalidParams();
        }
        return {
            sessionId: sessionId,
            prompt: prompt as acp.ContentBlock[],
            steerId,
        };
    }

    private createSessionConfigOptions(sessionState: SessionState): Array<acp.SessionConfigOption> {
        const currentModelId = ModelId.fromString(sessionState.currentModelId);
        const useRecommendedValue = clientSupportsAirCapability(
            this.clientCapabilities,
            AIR_RECOMMENDED_CONFIG_VALUE_KEY,
        );
        const currentModel = this.findCurrentModel(sessionState.availableModels, sessionState.currentModelId);
        const recommendedModelId = useRecommendedValue
            ? sessionState.availableModels.find(model => model.isDefault)?.id
            : undefined;
        const configOptions = [
            sessionState.agentMode.toConfigOption(sessionState.clientCapabilities.airClient),
            createCollaborationModeConfigOption(sessionState.collaborationMode),
            createModelConfigOption(sessionState.availableModels, currentModelId.model, recommendedModelId),
        ];
        if (sessionState.supportedReasoningEfforts.length > 0) {
            configOptions.push(
                createReasoningEffortConfigOption(
                    sessionState.supportedReasoningEfforts,
                    currentModelId.effort,
                    useRecommendedValue ? currentModel?.defaultReasoningEffort : undefined,
                ),
            );
        }
        if (sessionState.currentModelSupportsFast) {
            configOptions.push(createFastModeConfigOption(
                sessionState.fastModeEnabled,
                this.booleanConfigOptionsSupported,
            ));
        }
        return configOptions;
    }

    private createSessionConfigOptionsResponse(sessionState: SessionState): {
        configOptions?: Array<acp.SessionConfigOption>;
        _meta?: Record<string, unknown>;
    } {
        if (!this.isSessionConfigEnabled()) {
            return {};
        }
        return {
            configOptions: this.createSessionConfigOptions(sessionState),
            ...this.createModelCapabilitiesMeta(sessionState),
        };
    }

    /**
     * Publishes what each model can do, not just what the current one can.
     *
     * `configOptions` is rebuilt per model — `fast-mode` appears only while the
     * current model has a fast speed tier, and the effort list is that model's —
     * so a client reading it learns nothing about any other model, and there is
     * no ACP request that asks. This data is already in hand here, from the same
     * `Model` objects those options are built from; dropping it forced clients to
     * guess or to refuse selections that are perfectly valid.
     *
     * Self-declared and advisory: it describes this account's catalog at this
     * moment, and the live session state remains the authority.
     */
    private createModelCapabilitiesMeta(sessionState: SessionState): {
        _meta?: Record<string, unknown>;
    } {
        const models = sessionState.availableModels;
        if (models.length === 0) {
            return {};
        }
        return {
            _meta: {
                lody: {
                    modelCapabilities: {
                        version: 1,
                        models: Object.fromEntries(
                            models.map((model) => [
                                model.id,
                                {
                                    effortValues: model.supportedReasoningEfforts.map(
                                        (effort) => effort.reasoningEffort,
                                    ),
                                    fastMode: modelSupportsFast(model),
                                },
                            ]),
                        ),
                    },
                },
            },
        };
    }

    /** The v2 `configOptions` field for session responses (`session/new`, `session/resume`). */
    private createSessionConfigOptionsResponseV2(sessionState: SessionState): {
        configOptions?: Array<acpV2.SessionConfigOption>;
    } {
        const {configOptions} = this.createSessionConfigOptionsResponse(sessionState);
        return configOptions ? {configOptions: toV2ConfigOptions(configOptions)} : {};
    }

    private isSessionConfigEnabled(): boolean {
        // Temporarily disabled for JB IDEs 2026.1 due to issues in session_config (LLM-28118)
        return !isJetBrains2026_1Client(this.clientInfo);
    }

    private publishCurrentGoalAsync(sessionState: SessionState, sessionGeneration: number): void {
        void this.publishCurrentGoalBestEffort(sessionState, sessionGeneration, true);
    }

    private publishAsyncTasksAsync(sessionState: SessionState, sessionGeneration: number): void {
        if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)) return;
        sessionState.asyncTasks.refresh();
    }

    private async publishCurrentGoalBestEffort(
        sessionState: SessionState,
        sessionGeneration: number,
        force: boolean,
    ): Promise<void> {
        try {
            await this.publishCurrentGoal(sessionState, sessionGeneration, force);
        } catch (err) {
            logger.error(`Failed to publish current goal for session ${sessionState.sessionId}`, err);
        }
    }

    private async publishCurrentGoal(
        sessionState: SessionState,
        sessionGeneration: number,
        force: boolean,
    ): Promise<void> {
        const requestRevision = ++sessionState.goalRevision;
        const goal = await this.runWithProcessCheck(() => this.codexAcpClient.getGoal(sessionState.sessionId));
        const snapshot = goal === null ? null : toThreadGoalSnapshot(goal);
        if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)
            || sessionState.goalRevision !== requestRevision) {
            return;
        }
        await this.publishGoalSnapshot(sessionState, snapshot, force, false);
    }

    private sessionPublishIsCurrent(sessionState: SessionState, sessionGeneration: number): boolean {
        return this.sessions.get(sessionState.sessionId) === sessionState
            && this.getSessionGeneration(sessionState.sessionId) === sessionGeneration
            && !this.sessionIsClosing(sessionState.sessionId);
    }

    private async startGoalContinuationIfCurrent(
        sessionState: SessionState,
        sessionGeneration: number,
        goalControlGeneration: number,
        expectedGoal: ThreadGoal,
    ): Promise<void> {
        await this.startNewTurnFromExternalPrompt({
            sessionId: sessionState.sessionId,
            prompt: GOAL_CONTINUATION_PROMPT,
        }, "Goal continuation", async () => {
            if (!this.sessionPublishIsCurrent(sessionState, sessionGeneration)
                || this.goalControlGenerations.get(sessionState.sessionId) !== goalControlGeneration) {
                return false;
            }
            const currentGoal = await this.runWithProcessCheck(() => this.codexAcpClient.getGoal(sessionState.sessionId));
            return currentGoal?.status === "active"
                && currentGoal.objective === expectedGoal.objective
                && currentGoal.createdAt === expectedGoal.createdAt
                && this.goalControlGenerations.get(sessionState.sessionId) === goalControlGeneration;
        });
    }


    private bumpGoalControlGeneration(sessionId: string): number {
        const generation = (this.goalControlGenerations.get(sessionId) ?? 0) + 1;
        this.goalControlGenerations.set(sessionId, generation);
        return generation;
    }


    private async publishGoalSnapshot(
        sessionState: SessionState,
        snapshot: ThreadGoalSnapshot | null,
        force: boolean,
        incrementRevision = true,
    ): Promise<void> {
        if (incrementRevision) {
            sessionState.goalRevision += 1;
        }
        if (!force && sameThreadGoalSnapshot(sessionState.currentGoal, snapshot)) {
            return;
        }
        sessionState.currentGoal = snapshot;
        const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
        await session.update({
            sessionUpdate: "session_info_update",
            _meta: {
                lody: {goal: snapshot},
            },
        });
    }

    private findCurrentModel(models: Model[], currentModelId: string): Model | undefined {
        const modelId = ModelId.fromString(currentModelId);
        return models.find(m => m.id === modelId.model);
    }

    private createModelState(availableModels: Model[], selectedModelId: string): LegacySessionModelState {
        const allowedModels = availableModels
            .flatMap((model) =>
                model.supportedReasoningEfforts.map((effort) => ({
                    modelId: ModelId.fromComponents(model, effort.reasoningEffort).toString(),
                    name: `${formatModelDisplayName(model.displayName)} (${effort.reasoningEffort})`,
                    description: `${model.description} ${effort.description}`,
                }))
            );
        return {
            availableModels: allowedModels,
            currentModelId: selectedModelId,
        }
    }

    private async getOrCreateSessionWithHistory(
        request: WithAcpMcpServers<acp.LoadSessionRequest>
    ): Promise<{
        sessionId: SessionId;
        modelState: LegacySessionModelState;
        modeState: SessionModeState;
        thread: Thread;
        availableCommands: acp.AvailableCommand[];
        history: AsyncIterable<ThreadItemEntry[]>;
        sessionState: SessionState;
        // Settles the baseline tracker's `ready` gate; resolve after `streamThreadHistory` so a
        // live goal-turn frame Codex fires right after resume/load never races ahead of replay.
        settleTrackerReady: (state: SessionState | null) => void;
    }> {
        const requestedSessionGeneration = this.beginSessionOpen(request.sessionId);
        await this.checkAuthorization();
        const requestedMcpServers = request.mcpServers ?? [];
        const mcpServerStartupVersion = requestedMcpServers.length > 0
            ? this.codexAcpClient.getMcpServerStartupVersion()
            : null;

        logger.log(`Load existing session: ${request.sessionId}...`);
        let subscribed = false;
        // Registered before `thread/resume` is even sent; see `startCodexTurnTracker`.
        const [trackerReady, settleTrackerReady] = createDeferred<SessionState | null>();
        this.startCodexTurnTracker(request.sessionId, trackerReady);
        let sessionMetadata: SessionMetadataWithThread;
        try {
            sessionMetadata = await this.runWithProcessCheck(() =>
                this.codexAcpClient.loadSession(request, () => {
                    subscribed = true;
                })
            );
        } catch (err) {
            settleTrackerReady(null);
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            } else {
                // `thread/resume` never subscribed the connection, so there is nothing for
                // `cleanupStaleSessionOpen` to unsubscribe; just drop the local handler.
                this.codexAcpClient.discardSessionSubscription(request.sessionId);
            }
            throw err;
        }

        const {sessionId, currentModelId, models, thread} = sessionMetadata;
        const authProvider = sessionMetadata.modelProvider ?? this.codexAcpClient.getModelProvider();
        let authState: ActiveAuthState;
        try {
            authState = await this.getAuthStateForProvider(authProvider);
        } catch (err) {
            settleTrackerReady(null);
            if (subscribed) {
                await this.cleanupStaleSessionOpen(request.sessionId, requestedSessionGeneration);
            }
            throw err;
        }
        if (!this.sessionOpenCanInstall(sessionId, requestedSessionGeneration)) {
            settleTrackerReady(null);
            subscribed = false;
            await this.closeStaleSessionOpen(sessionId, requestedSessionGeneration);
        }
        const sessionMcpServers = this.resolveSessionMcpServers(requestedMcpServers, true);
        const currentModel = this.findCurrentModel(models, currentModelId);
        const currentModelSupportsFast = modelSupportsFast(currentModel);
        const sessionState: SessionState = {
            sessionId: sessionId,
            currentModelId: currentModelId,
            availableModels: models,
            supportedReasoningEfforts: currentModel?.supportedReasoningEfforts ?? [],
            supportedInputModalities: currentModel?.inputModalities ?? ["text", "image"],
            agentMode: AgentMode.getInitialAgentMode(),
            collaborationMode: sessionMetadata.collaborationMode,
            currentTurnId: null,
            interruptTurnId: null,
            codexReportedRunningTurnId: null,
            lastTokenUsage: null,
            totalTokenUsage: null,
            modelContextWindow: null,
            rateLimits: null,
            account: authState.account,
            authConfigured: authState.authConfigured,
            authProvider: authProvider,
            cwd: request.cwd,
            additionalDirectories: sessionMetadata.additionalDirectories,
            mcpServers: requestedMcpServers,
            fastModeEnabled: sessionMetadata.currentServiceTier === "fast",
            currentModelSupportsFast: currentModelSupportsFast,
            sessionMcpServers: sessionMcpServers,
            clientCapabilities: this.capabilities,
            goalRevision: 0,
            sessionTitle: null,
            sessionTitleSource: "unset",
            subagents: new CodexSubagentEventRouter(
                sessionId,
                clientSupportsSubagents(this.clientCapabilities),
                new ACPSessionConnection(this.connection, sessionId),
                supportsLodySubagentEvents(this.clientCapabilities),
                childSessionId => this.reportingConnection.reports.releaseOpen(childSessionId),
            ),
            asyncTasks: this.createAsyncTasks(sessionId),
            compactions: new CodexSessionCompactions(),
            toolCallReports: this.reportingConnection.reports,
            openToolCalls: new CodexSessionToolCalls(),
            awaitingClientLoad: false,
        };
        this.installSessionState(sessionState);
        this.publishRateLimitsAsync(sessionState);
        subscribed = false;

        if (requestedMcpServers.length > 0 && mcpServerStartupVersion !== null) {
            this.pendingMcpStartupSessions.set(
                sessionId,
                this.createPendingMcpStartupSession(requestedMcpServers, mcpServerStartupVersion),
            );
            this.publishMcpStartupStatusAsync(sessionId);
        }

        const availableCommands = await this.availableCommands.getAvailableCommands(sessionState);
        await this.publishCurrentGoalBestEffort(sessionState, requestedSessionGeneration, true);
        const sessionModelState: LegacySessionModelState = this.createModelState(models, currentModelId);
        const sessionModeState: SessionModeState =
            sessionState.agentMode.toSessionModeState(sessionState.clientCapabilities.airClient);

        return {
            sessionId: sessionId,
            modelState: sessionModelState,
            modeState: sessionModeState,
            thread: thread,
            availableCommands,
            history: sessionMetadata.history,
            sessionState: sessionState,
            settleTrackerReady: settleTrackerReady,
        };
    }

    /**
     * Sends the history of a loaded session one page of items at a time. The
     * adapter keeps only the current page, not the whole history.
     */
    private async streamThreadHistory(
        sessionId: string,
        thread: Thread,
        history: AsyncIterable<ThreadItemEntry[]>,
    ): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const sessionState = this.getSessionState(sessionId);
        const generation = this.getSessionGeneration(sessionId);
        const isOpen = () => this.getSessionGeneration(sessionId) === generation;
        const pages = history[Symbol.asyncIterator]();
        const first = await pages.next();
        const firstPage = first.done ? [] : first.value;
        // The first user message of the first page names the session.
        await this.publishThreadHistoryTitle(session, sessionState, thread, firstPage.map(entry => entry.item));
        const entryPages = this.rememberHistoryTurns(pagesStartingWith(firstPage, pages));
        // Hiding the `/review` reviewer prompt is a v2-only change (user decision): v1 keeps
        // showing it, as it always has.
        const itemPages = untilSessionClose(
            this.protocolVersion === 2 ? withoutReviewerPrompts(entryPages) : itemsOfEntries(entryPages),
            isOpen,
        );
        if (clientSupportsSubagents(this.clientCapabilities)) {
            await this.streamNativeThreadHistory(
                sessionId,
                itemPages,
                sessionState,
                new Set([sessionId]),
                new Set(),
                isOpen,
            );
            return;
        }
        // Older rollout stores can omit native tool items. Preserve the v1 recovery path;
        // paginated stores use their authoritative item stream.
        const fallback = this.protocolVersion === 1 && thread.historyMode !== "paginated"
            ? await createResponseItemHistoryFallbackUpdates(thread, resolveTerminalOutputMode(this.clientCapabilities))
            : null;
        const recoveredUpdates: UpdateSessionEvent[] = [];
        const startedReplayMessages = new Set<string>();
        for await (const items of itemPages) {
            for (const item of items) {
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                for (const update of await this.createHistoryUpdates(item, sessionState)) {
                    if (this.protocolVersion === 2) {
                        await this.sendReplayMessageStart(session, update, startedReplayMessages);
                    }
                    if (fallback) recoveredUpdates.push(update);
                    else await session.update(update);
                }
            }
        }
        if (fallback) for (const update of mergeHistoryUpdates(fallback, recoveredUpdates)) await session.update(update);
    }

    /**
     * On v2, replay reconstructing a message from its beginning via chunks MUST first send a
     * whole-message update with `content: []` for the same id, clearing any content the client
     * already holds for it (`session-setup.mdx`). No-op for chunks with no messageId: those get
     * a fresh random id downstream instead (`toV2SessionUpdate`), so there is nothing to key on
     * ahead of time.
     */
    private async sendReplayMessageStart(
        session: ACPSessionConnection,
        update: UpdateSessionEvent,
        started: Set<string>,
    ): Promise<void> {
        const kind = replayMessageStartKind(update.sessionUpdate);
        const messageId = kind ? (update as {messageId?: string | null}).messageId : null;
        if (!kind || !messageId) {
            return;
        }
        const key = `${kind}:${messageId}`;
        if (started.has(key)) {
            return;
        }
        started.add(key);
        await session.startReplayMessage(kind, messageId);
    }

    private async streamNativeThreadHistory(
        sessionId: string,
        itemPages: AsyncIterable<ThreadItem[]>,
        sessionState: SessionState,
        ancestry: Set<string>,
        unreadableChildren: Set<string>,
        isOpen: () => boolean,
    ): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        const announced = new Map<string, {generation: number; sessionId: string; terminal: boolean}>();
        // v2 only (this path also serves v1's native replay, unchanged there).
        const startedReplayMessages = new Set<string>();
        for await (const items of itemPages) {
            for (const item of items) {
                if (!isOpen()) throw new SessionClosedDuringLoadError();
                if (item.type === "subAgentActivity") {
                    const activityKind = item.kind as string;
                    if (activityKind === "started") {
                        const previous = announced.get(item.agentThreadId);
                        if (previous && !previous.terminal) continue;
                        const generation = (previous?.generation ?? 0) + 1;
                        const childSessionId = generation === 1
                            ? item.agentThreadId
                            : `${item.agentThreadId}:generation:${generation}`;
                        const name = nameFromAgentPath(item.agentPath, `Agent ${item.agentThreadId.slice(-8)}`);
                        await session.update({
                            sessionUpdate: "subagent_spawned",
                            subagentSessionId: childSessionId,
                            name,
                            task: `Delegated task for ${name}`,
                            capabilities: {},
                        });
                        announced.set(item.agentThreadId, {generation, sessionId: childSessionId, terminal: false});
                        if (!ancestry.has(item.agentThreadId) && !unreadableChildren.has(item.agentThreadId)) {
                            // Each generation of a child is one turn of the child thread. The
                            // adapter reads only the items of that turn, one page at a time.
                            let childItems: AsyncIterable<ThreadItem[]> | null = null;
                            try {
                                childItems = await this.codexAcpClient.readSessionTurnItems(item.agentThreadId, generation - 1);
                            }
                            catch (error) {
                                unreadableChildren.add(item.agentThreadId);
                                logger.error(`Failed to read subagent history ${item.agentThreadId}`, error);
                            }
                            if (childItems) {
                                const commandIds = new Set<string>();
                                try {
                                    await this.streamNativeThreadHistory(
                                        childSessionId,
                                        withCommandIds(untilSessionClose(childItems, isOpen), commandIds),
                                        sessionState,
                                        new Set([...ancestry, item.agentThreadId]),
                                        unreadableChildren,
                                        isOpen,
                                    );
                                }
                                catch (error) {
                                    if (error instanceof SessionClosedDuringLoadError) throw error;
                                    // The child pages are read lazily. A child that fails midway keeps what it sent.
                                    unreadableChildren.add(item.agentThreadId);
                                    logger.error(`Failed to read subagent history ${item.agentThreadId}`, error);
                                }
                                try {
                                    await sessionState.asyncTasks.recover(
                                        item.agentThreadId,
                                        childSessionId,
                                        commandIds,
                                    );
                                } catch (error) {
                                    logger.error(`Failed to restore background terminals for ${item.agentThreadId}`, error);
                                }
                            }
                        }
                    }
                    else if (activityKind === "completed" || activityKind === "interrupted") {
                        const child = announced.get(item.agentThreadId);
                        if (!child) {
                            const name = nameFromAgentPath(item.agentPath, `Agent ${item.agentThreadId.slice(-8)}`);
                            await session.update({
                                sessionUpdate: "subagent_spawned",
                                subagentSessionId: item.agentThreadId,
                                name,
                                task: `Delegated task for ${name}`,
                                capabilities: {},
                            });
                            announced.set(item.agentThreadId, {
                                generation: 1,
                                sessionId: item.agentThreadId,
                                terminal: false,
                            });
                            continue;
                        }
                        if (child.terminal) continue;
                        await session.update({
                            sessionUpdate: "subagent_state_update",
                            subagentSessionId: child.sessionId,
                            state: activityKind === "completed" ? "completed" : "cancelled",
                        });
                        child.terminal = true;
                    }
                    continue;
                }
                // The activity items above replay the lifecycle of a spawn. A control call is a tool call, as in the live session.
                if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") continue;
                for (const update of await this.createHistoryUpdates(item, sessionState)) {
                    if (this.protocolVersion === 2) {
                        await this.sendReplayMessageStart(session, update, startedReplayMessages);
                    }
                    await session.update(update);
                }
            }
        }
        for (const child of announced.values()) {
            if (child.terminal) continue;
            await session.update({
                sessionUpdate: "subagent_state_update",
                subagentSessionId: child.sessionId,
                state: "disconnected",
            });
        }
    }

    private async publishThreadHistoryTitle(
        session: ACPSessionConnection,
        sessionState: HistoryProjectionState,
        thread: Thread,
        firstItems: ThreadItem[],
    ): Promise<void> {
        const explicitTitle = this.normalizeSessionTitle(thread.name);
        if (explicitTitle) {
            sessionState.sessionTitle = explicitTitle;
            sessionState.sessionTitleSource = "explicit";
            await session.update({
                sessionUpdate: "session_info_update",
                title: explicitTitle,
                _meta: {
                    lody: {
                        titleSource: "explicit",
                    },
                },
            });
            return;
        }

        const historyTitle = this.findFirstUserMessageTitle(firstItems)
            ?? this.normalizeSessionTitle(thread.preview);
        await this.publishFallbackSessionTitle(sessionState, historyTitle);
    }

    private findFirstUserMessageTitle(items: ThreadItem[]): string | null {
        for (const item of items) {
            if (item.type !== "userMessage") continue;
            const title = this.normalizeSessionTitle(item.content
                .filter((input): input is Extract<UserInput, {type: "text"}> => input.type === "text")
                .map(input => input.text)
                .join(" "));
            if (title) return title;
        }
        return null;
    }

    private async publishFallbackSessionTitle(
        sessionState: HistoryProjectionState,
        title: string | null,
    ): Promise<void> {
        if (sessionState.sessionTitleSource !== "unset" || !title) return;
        sessionState.sessionTitle = title;
        sessionState.sessionTitleSource = "fallback";
        const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
        await session.update({
            sessionUpdate: "session_info_update",
            title,
            _meta: {
                lody: {
                    titleSource: "fallback",
                },
            },
        });
    }

    private async publishAgentFileChangeReport(
        sessionState: SessionState,
        turnId: string | null,
        request: AgentFileChangeReportRequest,
        unavailableReason: AgentFileChangeReportUnavailableReason,
        turnDiff: string,
        workspace: AgentFileChangeWorkspace,
    ): Promise<void> {
        let report: AgentFileChangeReport;
        try {
            report = turnId === null
                ? createUnavailableAgentFileChangeReport(request.requestId, unavailableReason)
                : createReportedAgentFileChangeReport(request.requestId, turnDiff, workspace);
        } catch (error) {
            logger.error(
                error instanceof AgentFileChangeReportError
                    ? "Agent file-change report unavailable"
                    : "Agent file-change report failed unexpectedly",
                error,
            );
            report = createUnavailableAgentFileChangeReport(
                request.requestId,
                error instanceof AgentFileChangeReportError ? error.reason : "providerError",
            );
        }
        try {
            const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
            await session.update({
                sessionUpdate: "session_info_update",
                _meta: {
                    [JETBRAINS_META_KEY]: {
                        [AIR_META_KEY]: {
                            [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                            [AIR_AGENT_FILE_CHANGE_REPORT_KEY]: report,
                        },
                    },
                },
            });
        } catch (error) {
            logger.error("Failed to publish agent file-change report", error);
        }
    }

    private createPromptFallbackTitle(prompt: acp.ContentBlock[]): string | null {
        return this.normalizeSessionTitle(prompt
            .filter((block): block is Extract<acp.ContentBlock, {type: "text"}> => block.type === "text")
            .map(block => block.text)
            .join(" "));
    }

    private normalizeSessionTitle(title: string | null | undefined): string | null {
        const normalized = title?.replace(/\s+/g, " ").trim() ?? "";
        return normalized.length > 0 ? normalized : null;
    }

    private async *rememberHistoryTurns(pages: AsyncIterable<ThreadItemEntry[]>): AsyncGenerator<ThreadItemEntry[]> {
        for await (const page of pages) {
            for (const entry of page) this.historyTurnIds.set(entry.item, entry.turnId);
            yield page;
        }
    }

    private async createHistoryUpdates(item: ThreadItem, sessionState: Pick<SessionState, "clientCapabilities">, turnId: string | undefined = this.historyTurnIds.get(item)): Promise<UpdateSessionEvent[]> {
        const renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        switch (item.type) {
            case "userMessage":
                return this.createUserMessageUpdates(item);
            case "hookPrompt":
            case "functionCallOutput":
            case "sleep":
                return [];
            case "subAgentActivity":
                return [renderer.render(SubagentActivityReporter.activity(item, "completed", "start"))];
            case "agentMessage": {
                const meta = createMessagePhaseMeta(item.phase, sessionState.clientCapabilities.airClient);
                return [{
                    sessionUpdate: "agent_message_chunk",
                    messageId: item.id,
                    content: { type: "text", text: item.text },
                    _meta: turnId ? {...meta, ...createCodexAgentMessageMeta(item.phase, turnId)} : (meta ?? {}),
                }];
            }
            case "reasoning":
                return this.createReasoningUpdates(item);
            case "fileChange":
                return [renderer.render(FileChangeReporter.started(item, renderer.capabilities.diffPatchFormat))];
            case "commandExecution":
                return CommandReporter.history(item).map(facts => renderer.render(facts));
            case "mcpToolCall":
                return [renderer.render(McpToolReporter.started(
                    item,
                    clientSupportsMcpApps(this.clientCapabilities) ? readMcpAppMeta(item) : null,
                ))];
            case "dynamicToolCall":
                return [renderer.render(DynamicToolReporter.started(item))];
            case "collabAgentToolCall":
                return [renderer.render(CollabAgentReporter.started(item))];
            case "webSearch":
                return [renderer.render(WebSearchReporter.history(item))];
            case "imageView":
                return [renderer.render(ImageViewReporter.viewed(item))];
            case "imageGeneration":
                return [renderer.render(ImageGenerationReporter.whole(item))];
            case "enteredReviewMode":
                return [this.createReviewModeUpdate(item, true)];
            case "exitedReviewMode":
                return [this.createReviewModeUpdate(item, false)];
            case "contextCompaction":
                return [clientSupportsCompaction(this.clientCapabilities)
                    ? createCompactionUpdate(item.id, "completed")
                    : renderer.render(CompactionReporter.history(item))];
            case "plan":
                return item.text.length > 0 ? [this.createPlanHistoryUpdate(item)] : [];
        }
    }

    private createUserMessageUpdates(item: ThreadItem & { type: "userMessage" }): UpdateSessionEvent[] {
        const updates: UpdateSessionEvent[] = [];
        // On v2, a message inserted via `session/prompt` is replayed under the id the client
        // provided then (`clientId`), so it round-trips as the same message on reconnect; v1 has
        // no such client-minted id and keeps using Codex's own item id.
        const messageId = this.protocolVersion === 2 ? (item.clientId ?? item.id) : item.id;
        for (const input of item.content) {
            const blocks = this.userInputToContentBlocks(input);
            for (const block of blocks) {
                updates.push(createUserMessageChunk(block, messageId));
            }
        }
        return updates;
    }

    private createReasoningUpdates(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent[] {
        const messageId = item.id;
        return sanitizeReasoningParts(item.summary, item.content)
            .map((text) => createAgentTextThoughtChunk(text, messageId));
    }

    private createReviewModeUpdate(
        item: ThreadItem & { type: "enteredReviewMode" | "exitedReviewMode" },
        entered: boolean
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "agent_message_chunk",
            // v2 requires a replayed message to carry a stable id; use the persisted item id.
            // v1 keeps no id here, to stay byte-identical with existing clients.
            ...(this.protocolVersion === 2 ? {messageId: item.id} : {}),
            content: {
                type: "text",
                text: `${entered ? "Entered" : "Exited"} review mode: ${item.review}`,
            },
        };
    }

    private createPlanHistoryUpdate(
        item: ThreadItem & { type: "plan" }
    ): UpdateSessionEvent {
        if (this.capabilities.planUpdates) {
            return {
                sessionUpdate: "plan_update",
                plan: {
                    type: "markdown",
                    planId: item.id,
                    content: item.text,
                },
            };
        }
        return createAgentTextMessageChunk(
            item.text,
            item.id,
            createMessagePhaseMeta("final_answer", this.capabilities.airClient),
        );
    }

    private userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
        switch (input.type) {
            case "text":
                return input.text.length > 0 ? [{ type: "text", text: input.text }] : [];
            case "image":
                return [{
                    type: "text",
                    text: "url" in input
                        ? this.formatUriAsLink("image", input.url)
                        : `image:${input.fileId}`,
                }];
            case "localImage": {
                const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
                return [{ type: "text", text: this.formatUriAsLink(null, uri) }];
            }
            case "skill":
                return [{ type: "text", text: `skill:${input.name} (${input.path})` }];
            case "audio":
            case "localAudio":
            case "mention":
                // These inputs are not currently represented in ACP history replay.
                return [];
        }
    }

    private formatUriAsLink(name: string | null, uri: string): string {
        if (name && name.length > 0) {
            return `[@${name}](${uri})`;
        }
        if (uri.startsWith("file://")) {
            const path = uri.replace("file://", "");
            const fileName = path.split("/").pop() ?? path;
            return `[@${fileName}](${uri})`;
        }
        return uri;
    }

    getSessionState(sessionId: string): SessionState {
        const sessionState = this.sessions.get(sessionId);
        if (!sessionState) {
            throw new Error(`Session ${sessionId} not found`);
        }
        return sessionState;
    }

    private permissionLifecycleContext(sessionState: SessionState): PermissionLifecycleContext {
        const existing = this.permissionLifecycleContexts.get(sessionState);
        if (existing) return existing;
        const context = new PermissionLifecycleContext(sessionState);
        this.permissionLifecycleContexts.set(sessionState, context);
        return context;
    }

    private resolveSessionMcpServers(
        mcpServers: Array<AcpMcpServer>,
        recoverFromStartup: boolean,
    ): Array<string> {
        // Explicit MCP servers from the request are the primary source of truth for the session.
        const requestedServerNames = getRequestedMcpServerNames(mcpServers);
        if (requestedServerNames.length > 0) {
            return requestedServerNames;
        }
        // Fresh sessions without MCP config should not inherit any session MCP state.
        if (!recoverFromStartup) {
            return [];
        }
        // Without a thread-scoped startup completion event, loadSession/resumeSession can no longer
        // recover omitted session MCP server names. Treat the session set as unknown unless ACP
        // explicitly provided mcpServers in the request.
        logger.log("Skipping MCP server recovery for load/resume without explicit mcpServers");
        return [];
    }

    private publishMcpStartupStatusAsync(sessionId: string): void {
        void this.doPublishMcpStartupStatus(sessionId);
    }

    private createPendingMcpStartupSession(
        mcpServers: Array<AcpMcpServer>,
        afterVersion: number,
    ): PendingMcpStartupSession {
        const requestedServers = new Set(getRequestedMcpServerNames(mcpServers));
        return {
            requestedServers,
            startup: this.runWithProcessCheck(() =>
                this.codexAcpClient.awaitMcpServerStartup(Array.from(requestedServers), afterVersion)
            ),
        };
    }

    private async doPublishMcpStartupStatus(sessionId: string): Promise<void> {
        const pendingStartup = this.pendingMcpStartupSessions.get(sessionId);
        if (!pendingStartup) {
            return;
        }

        try {
            const mcpStartup = await pendingStartup.startup;
            if (!this.sessions.has(sessionId)
                || this.sessionIsClosing(sessionId)
                || this.pendingMcpStartupSessions.get(sessionId) !== pendingStartup) {
                return;
            }
            await this.publishMcpStartupStatus(sessionId, mcpStartup, pendingStartup.requestedServers);
        } catch (err) {
            logger.error(`Failed to publish MCP startup status for session ${sessionId}`, err);
        } finally {
            if (this.pendingMcpStartupSessions.get(sessionId) === pendingStartup) {
                this.pendingMcpStartupSessions.delete(sessionId);
            }
        }
    }

    private async publishMcpStartupStatus(
        sessionId: string,
        mcpStartup: McpStartupResult,
        requestedServers?: Set<string>
    ): Promise<void> {
        const filteredStartup = requestedServers
            ? {
                ready: mcpStartup.ready.filter(server => requestedServers.has(server)),
                failed: mcpStartup.failed.filter(server => requestedServers.has(server.server)),
                cancelled: mcpStartup.cancelled.filter(server => requestedServers.has(server)),
            }
            : mcpStartup;

        const failuresAfterOauth: typeof filteredStartup.failed = [];
        const readyAfterOauth = [...filteredStartup.ready];
        for (const failure of filteredStartup.failed) {
            if (failure.failureReason !== "reauthenticationRequired"
                || !clientSupportsUrlElicitation(this.clientCapabilities)) {
                failuresAfterOauth.push(failure);
                continue;
            }
            try {
                const authenticated = await this.authenticateMcpServer(sessionId, failure.server);
                if (authenticated) {
                    readyAfterOauth.push(failure.server);
                } else {
                    failuresAfterOauth.push(failure);
                }
            } catch (error) {
                logger.error(`Failed to authenticate MCP server ${failure.server}`, error);
                failuresAfterOauth.push(failure);
            }
        }

        const renderer = new AcpToolCallRenderer(this.capabilities);
        for (const facts of McpStartupReporter.failures({
            ...filteredStartup,
            ready: readyAfterOauth,
            failed: failuresAfterOauth,
        })) {
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId,
                update: renderer.render(facts),
            });
        }
    }

    private async authenticateMcpServer(sessionId: string, serverName: string): Promise<boolean> {
        const elicitationId = `mcp-oauth-${randomUUID()}`;
        const completed = this.codexAcpClient.awaitMcpServerOauthLoginCompleted(serverName, sessionId);
        const login = await this.codexAcpClient.mcpServerOauthLogin({
            name: serverName,
            threadId: sessionId,
        });
        const elicitation = Promise.resolve(this.connection.request(
            acp.methods.client.elicitation.create,
            {
                mode: "url",
                sessionId,
                message: `Authenticate with MCP server ${serverName}`,
                url: login.authorizationUrl,
                elicitationId,
            },
        ));
        const first = await Promise.race([
            completed.then(result => ({type: "completed" as const, result})),
            elicitation.then(response => ({type: "elicitation" as const, response})),
        ]);
        if (first.type === "elicitation" && !acp.CreateElicitationResponse.isAccept(first.response)) {
            return false;
        }
        const result = first.type === "completed" ? first.result : await completed;
        await this.connection.notify(acp.methods.client.elicitation.complete, {elicitationId});
        return result.success;
    }

    private trackActivePrompt(sessionId: string): ActivePrompt {
        let resolveCompletion: () => void = () => {};
        const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
        });
        let resolveCloseSignal: (value: null) => void = () => {};
        const closeSignal = new Promise<null>((resolve) => {
            resolveCloseSignal = resolve;
        });
        let resolveCancelSignal: (value: null) => void = () => {};
        const cancelSignal = new Promise<null>((resolve) => {
            resolveCancelSignal = resolve;
        });
        const abortController = new AbortController();
        const interactionAbortController = new AbortController();

        let completed = false;
        let closeRequested = false;
        const activePrompt: ActivePrompt = {
            completion,
            closeSignal,
            cancelSignal,
            signal: abortController.signal,
            interactionSignal: interactionAbortController.signal,
            cancelRequested: false,
            currentTurn: null,
            hasCompletedTurn: false,
            nativeCommandInFlight: false,
            requestCancel: () => {
                activePrompt.abortInteractions();
                if (abortController.signal.aborted) {
                    return;
                }
                abortController.abort();
                resolveCancelSignal(null);
            },
            requestClose: () => {
                if (closeRequested) {
                    return;
                }
                closeRequested = true;
                activePrompt.requestCancel();
                resolveCloseSignal(null);
            },
            abortInteractions: () => {
                interactionAbortController.abort();
            },
            complete: () => {
                if (completed) {
                    return;
                }
                completed = true;
                if (this.activePrompts.get(sessionId) === activePrompt) {
                    this.activePrompts.delete(sessionId);
                }
                this.clearPendingSteers(sessionId, activePrompt);
                resolveCompletion();
            },
        };

        this.activePrompts.set(sessionId, activePrompt);
        return activePrompt;
    }

    private setActivePromptTurn(activePrompt: ActivePrompt, turn: { threadId: string, turnId: string }): void {
        activePrompt.hasCompletedTurn = false;
        activePrompt.currentTurn = turn;
    }

    private clearPendingSteers(sessionId: string, activePrompt: ActivePrompt): void {
        const pending = this.pendingSteers.get(sessionId);
        if (!pending) return;
        for (const [steerId, steer] of pending) {
            if (steer.activePrompt === activePrompt && !steer.requestPending) pending.delete(steerId);
        }
        if (pending.size === 0) this.pendingSteers.delete(sessionId);
    }

    private async handleSteerAppliedNotification(
        sessionId: string,
        event: ServerNotification,
        activePrompt: ActivePrompt,
    ): Promise<void> {
        if (event.method !== "item/completed" || event.params.item.type !== "userMessage") return;
        const steerId = event.params.item.clientId;
        if (!steerId) return;
        const pending = this.pendingSteers.get(sessionId);
        if (!pending) return;
        const steer = pending.get(steerId);
        if (!steer || steer.activePrompt !== activePrompt
            || steer.threadId !== event.params.threadId || steer.turnId !== event.params.turnId) return;
        await this.acknowledgeSteer(sessionId, steerId, steer);
    }

    private removePendingSteer(sessionId: string, steerId: string, steer: PendingSteer): void {
        const pending = this.pendingSteers.get(sessionId);
        if (pending?.get(steerId) !== steer) return;
        pending.delete(steerId);
        if (pending.size === 0) this.pendingSteers.delete(sessionId);
    }

    private async acknowledgeSteer(sessionId: string, steerId: string, steer: PendingSteer): Promise<void> {
        if (steer.acknowledgement === null) {
            steer.acknowledgement = Promise.resolve().then(() =>
                this.connection.notify(CODEX_STEER_APPLIED_METHOD, {sessionId, steerId}));
            this.removePendingSteer(sessionId, steerId, steer);
            steer.resolveApplied();
        }
        await steer.acknowledgement;
    }

    private cancelBeforeTurnStarted(activePrompt: ActivePrompt): Promise<null> {
        return activePrompt.cancelSignal.then(() => {
            if (activePrompt.currentTurn === null && !activePrompt.nativeCommandInFlight) {
                return null;
            }
            return new Promise<null>(() => {});
        });
    }

    private observePromptRequestCancellation(
        signal: AbortSignal | undefined,
        sessionState: SessionState,
        activePrompt: ActivePrompt,
    ): () => void {
        if (!signal) {
            return () => {};
        }

        const onAbort = () => {
            if (this.activePrompts.get(sessionState.sessionId) !== activePrompt) {
                return;
            }
            logger.log("Prompt request cancelled", {sessionId: sessionState.sessionId});
            activePrompt.requestCancel();
            const turn = activePrompt.currentTurn;
            if (!turn) {
                return;
            }
            void this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, "Cancel");
        };

        if (signal.aborted) {
            onAbort();
            return () => {};
        }

        signal.addEventListener("abort", onAbort, {once: true});
        return () => signal.removeEventListener("abort", onAbort);
    }

    private createPendingTurnStart(): PendingTurnStart {
        let resolve: (turnId: string | null) => void = () => {};
        const promise = new Promise<string | null>((innerResolve) => {
            resolve = innerResolve;
        });
        return {promise, resolve};
    }

    /**
     * Takes this session's place in the shared per-session turn-start FIFO. Every codex-acp turn
     * starter (v1 `session/prompt`, v2 `session/prompt`, the goal-continuation and steering
     * fallbacks) calls this synchronously, before its first `await`, so no two starters can ever
     * decide to start a turn based on the same "is something running" snapshot: whichever calls
     * this first is queued ahead. `wait` resolves once the previous reservation on this session
     * releases; the caller must call `release()` exactly once it is safe for the next queued
     * starter to become visibly active (which may be later than when this starter's own request
     * is answered).
     */
    private acquireTurnStartReservation(sessionId: string): TurnStartReservation {
        const previousSlot = this.turnStartQueueTail.get(sessionId);
        const needsWait = previousSlot !== undefined && !previousSlot.settled;
        const wait = needsWait ? previousSlot!.promise : Promise.resolve();
        const slot: {promise: Promise<void>; settled: boolean} = {promise: Promise.resolve(), settled: false};
        let release: () => void = () => {};
        slot.promise = new Promise<void>((resolve) => {
            release = () => {
                slot.settled = true;
                resolve();
            };
        });
        this.turnStartQueueTail.set(sessionId, slot);
        return {wait, needsWait, release};
    }

    /**
     * Registers a callback that aborts a v2 `session/prompt` still queued behind a running turn.
     * Returns an unregister function the caller must invoke once it stops waiting (whether it was
     * cancelled or reached the front of the queue on its own).
     */
    private registerQueuedV2PromptCanceller(sessionId: string, canceller: () => void): () => void {
        let cancellers = this.queuedV2PromptCancellers.get(sessionId);
        if (!cancellers) {
            cancellers = new Set();
            this.queuedV2PromptCancellers.set(sessionId, cancellers);
        }
        cancellers.add(canceller);
        return () => cancellers!.delete(canceller);
    }

    /** Aborts every v2 `session/prompt` currently queued (not yet inserted) for a session. */
    private cancelQueuedV2Prompts(sessionId: string): void {
        const cancellers = this.queuedV2PromptCancellers.get(sessionId);
        if (!cancellers) {
            return;
        }
        for (const canceller of cancellers) {
            canceller();
        }
        cancellers.clear();
    }

    private async interruptPromptTurn(
        sessionState: SessionState,
        turn: { threadId: string, turnId: string },
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        this.codexAcpClient.markTurnStale({
            threadId: turn.threadId,
            turnId: turn.turnId,
        });
        try {
            await this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, requestName);
        } finally {
            this.codexAcpClient.resolveTurnInterrupted({
                threadId: turn.threadId,
                turnId: turn.turnId,
            });
        }
    }

    /**
     * Sends `turn/interrupt` and retries it against the registration race: right after a
     * turn (or review child turn) is started, Codex can briefly answer "no active turn to
     * interrupt", and once it registers a later turn under a different id, "expected active turn
     * id <completionTurnId> but found <Y>". Both are retried, with the id recomputed on every
     * attempt so a `turn/started` that arrives between retries is picked up.
     */
    private async requestTurnInterrupt(
        sessionState: SessionState,
        threadId: string,
        completionTurnId: string,
        requestName: "Cancel" | "Close",
    ): Promise<void> {
        let turnId = codexRunningTurnId(sessionState, completionTurnId);
        for (let attempt = 0; ; attempt++) {
            try {
                await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
                    threadId,
                    turnId,
                }));
                logger.log(`${requestName} - turnInterrupt succeeded`, {
                    sessionId: threadId,
                    currentTurnId: turnId,
                });
                return;
            } catch (err) {
                const promptStillActive = this.activePrompts.has(threadId);
                const mismatch = parseExpectedActiveTurnMismatch(err);
                const isMismatch = mismatch !== null
                    && mismatch.expected === turnId
                    && mismatch.found !== "";
                const retryable = promptStillActive
                    && (isNoActiveTurnError(err) || isMismatch)
                    && attempt < NO_ACTIVE_TURN_RETRY_DELAYS_MS.length;
                if (!retryable) {
                    logger.error(`${requestName} - turnInterrupt failed`, err);
                    return;
                }
                // The interrupt raced the turn's registration in Codex: the prompt
                // is still in flight, so the turn is about to become
                // interruptible. Dropping the interrupt here would let the turn run
                // to completion and answer `end_turn`, which ACP forbids after a
                // `session/cancel`.
                await new Promise(resolve => setTimeout(resolve, NO_ACTIVE_TURN_RETRY_DELAYS_MS[attempt]!));
                // Recompute after the wait: a `turn/started` may have landed in the meantime, and
                // `interruptTurnId` always wins once it is set. Otherwise fall back to the id Codex
                // just reported as active, or to the id we started with.
                turnId = isMismatch ? mismatch!.found : sessionState.interruptTurnId ?? completionTurnId;
                logger.log(`${requestName} - turn not interruptible yet, retrying`, {
                    sessionId: threadId,
                    currentTurnId: turnId,
                    attempt,
                });
            }
        }
    }

    private interruptLateStartedTurn(sessionState: SessionState, turn: { threadId: string, turnId: string }, activePrompt: ActivePrompt): void {
        if (activePrompt.nativeCommandInFlight) {
            this.codexAcpClient.markTurnStale(turn);
            // Interrupt acknowledgement cannot settle a submitted native command.
            void this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, "Cancel");
            return;
        }
        void this.interruptPromptTurn(sessionState, turn, "Close");
    }

    private promptShouldStop(sessionId: string, activePrompt: ActivePrompt): boolean {
        return activePrompt.signal.aborted || this.activePrompts.get(sessionId) !== activePrompt || this.sessionIsClosing(sessionId);
    }

    private async interruptSessionTurn(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
        resolveInterruptedTurn: boolean,
    ): Promise<void> {
        const turn = await this.getInterruptibleTurn(sessionState, requestName);
        if (!turn) {
            return;
        }

        logger.log(`${requestName} session requested`, {
            sessionId: sessionState.sessionId,
            threadId: turn.threadId,
            currentTurnId: turn.turnId,
        });
        if (resolveInterruptedTurn) {
            this.codexAcpClient.markTurnStale(turn);
        }
        try {
            await this.requestTurnInterrupt(sessionState, turn.threadId, turn.turnId, requestName);
            logger.log(`${requestName} - turnInterrupt succeeded`, {
                sessionId: sessionState.sessionId,
                threadId: turn.threadId,
                currentTurnId: turn.turnId,
            });
        } catch (err) {
            logger.error(`${requestName} - turnInterrupt failed`, err);
        } finally {
            if (resolveInterruptedTurn) {
                this.codexAcpClient.resolveTurnInterrupted(turn);
            }
        }
    }

    private async getInterruptibleTurn(
        sessionState: SessionState,
        requestName: "Cancel" | "Close",
    ): Promise<{ threadId: string, turnId: string } | null> {
        // `activePrompt.currentTurn` is the authoritative handle: command turns
        // (e.g. /review) run on their own thread, so pairing the turn id with
        // `sessionState.sessionId` would produce a (threadId, turnId) pair codex
        // does not know and the interrupt would silently no-op.
        const currentTurn = this.activePrompts.get(sessionState.sessionId)?.currentTurn;
        if (currentTurn) {
            return currentTurn;
        }
        if (sessionState.currentTurnId) {
            return {threadId: sessionState.sessionId, turnId: sessionState.currentTurnId};
        }

        const pendingTurnStart = this.pendingTurnStarts.get(sessionState.sessionId);
        if (!pendingTurnStart) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
            return null;
        }

        if (requestName === "Close") {
            pendingTurnStart.resolve(null);
            return null;
        }

        const turnId = await pendingTurnStart.promise;
        if (!turnId) {
            logger.log(`${requestName} request rejected: no current turn`, {sessionId: sessionState.sessionId});
            return null;
        }
        // `onTurnStarted` populates `currentTurn` (with the real thread id)
        // before resolving the pending turn start.
        const startedTurn = this.activePrompts.get(sessionState.sessionId)?.currentTurn;
        return startedTurn ?? {threadId: sessionState.sessionId, turnId};
    }

    /**
     * v2 `session/prompt`: answers `{messageId}` once the user message is inserted and lets the
     * turn run on in the background. A Codex prompt is inserted when Codex records its user
     * message; a locally handled command has no Codex turn, so it is inserted right away.
     */
    async promptV2(params: acpV2.PromptRequest, signal?: AbortSignal): Promise<acpV2.PromptResponse> {
        const sessionId = params.sessionId;
        const request = toV1PromptRequest(params);
        const sessionState = this.getSessionState(sessionId);
        if (this.sessionIsClosing(sessionId)) {
            throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
        }
        // A prompt overlapping a running one is queued behind it rather than rejected: take this
        // session's place in the shared turn-start FIFO now (before any await), then wait. Nothing
        // observable (response, user message, states) happens until this prompt reaches the front.
        const reservation = this.acquireTurnStartReservation(sessionId);
        if (reservation.needsWait) {
            // `session/cancel`/`session/close` drop this prompt while it waits here: race the
            // FIFO wait against a cancellation signal so the client sees `-32800` right away,
            // instead of only once the running turn ahead of it actually finishes. A
            // `$/cancel_request` for this specific request goes through the same canceller, so it
            // only drops this prompt and leaves the rest of the queue untouched.
            let cancelled = false;
            let markCancelled: () => void = () => { cancelled = true; };
            const cancelSignal = new Promise<void>((resolve) => {
                markCancelled = () => { cancelled = true; resolve(); };
            });
            const unregister = this.registerQueuedV2PromptCanceller(sessionId, markCancelled);
            const onRequestCancelled = () => markCancelled();
            if (signal) {
                if (signal.aborted) {
                    onRequestCancelled();
                } else {
                    signal.addEventListener("abort", onRequestCancelled, {once: true});
                }
            }
            await Promise.race([reservation.wait, cancelSignal]);
            unregister();
            signal?.removeEventListener("abort", onRequestCancelled);
            if (cancelled) {
                // Still release in the FIFO's own order once it is actually this prompt's turn,
                // so anything queued behind it does not start while the current turn is still
                // being interrupted.
                void reservation.wait.then(() => reservation.release());
                throw RequestError.requestCancelled(undefined, `Session ${sessionId} was cancelled before the prompt was inserted`);
            }
        }
        const promptKind = this.availableCommands.classifyPrompt(request.prompt);
        const messageId = randomUUID();
        const session = new ACPSessionConnection(this.connection, sessionId);
        this.v2PromptsInFlight.add(sessionId);
        const sendState = async (state: acpV2.StateUpdate) => {
            try {
                await session.updateState(state);
            } catch (error) {
                logger.error(`Failed to send the '${state.state}' state for session ${sessionId}`, error);
            }
        };
        return await new Promise<acpV2.PromptResponse>((resolve, reject) => {
            let running: Promise<void> | null = null;
            let inserted = false;
            // Set from `onTurnAdopted` when `turn/start` steers this prompt into a turn that was
            // already running unowned: that turn's `running` already went out before this
            // prompt existed, so this prompt must not send a second one.
            let turnWasAdopted = false;
            let startedTurn: {threadId: string, turnId: string} | null = null;
            let requestCancelHandled = false;
            // A `$/cancel_request` for a prompt whose `turn/start` was sent but has not landed
            // yet still has a pending request to answer: interrupt the turn it started (like
            // v1's `observePromptRequestCancellation`) and drop it with `-32800`. A turn this
            // prompt only adopted belongs to someone else (e.g. a Codex goal turn) and must
            // keep running -- only this request is dropped, still with `-32800`; whatever that
            // turn actually finishes with is reported normally once `run()` settles below.
            const dropPendingRequest = () => {
                if (inserted || requestCancelHandled) {
                    return;
                }
                requestCancelHandled = true;
                if (!turnWasAdopted && startedTurn !== null) {
                    void this.requestTurnInterrupt(sessionState, startedTurn.threadId, startedTurn.turnId, "Cancel");
                }
                reject(RequestError.requestCancelled(undefined, "The prompt request was cancelled before it was inserted"));
            };
            if (signal) {
                if (signal.aborted) {
                    dropPendingRequest();
                } else {
                    signal.addEventListener("abort", dropPendingRequest, {once: true});
                }
            }
            const onInserted = async () => {
                inserted = true;
                try {
                    for (const block of request.prompt) {
                        await session.update(createUserMessageChunk(block, messageId));
                    }
                } catch (error) {
                    logger.error(`Failed to send the user message for session ${sessionId}`, error);
                }
                resolve({messageId});
                if (turnWasAdopted) {
                    return;
                }
                // Report `running` only after the response has been queued, as the spec's sequence
                // shows (response, user message, then `running`). Awaiting it here holds back the
                // turn's later updates until it is sent.
                running = new Promise<void>(resolveTimer => setTimeout(resolveTimer, 0))
                    .then(() => sendState({state: "running"}));
                await running;
            };
            const run = async () => {
                if (promptKind.kind === "localCommand") {
                    await onInserted();
                    return await this.prompt(request, undefined, undefined, undefined, reservation);
                }
                return await this.prompt(request, undefined, undefined, {
                    clientUserMessageId: messageId,
                    onInserted,
                    onSyntheticInserted: async (syntheticId, prompt) => {
                        try {
                            for (const block of prompt) {
                                await session.update(createUserMessageChunk(block, syntheticId));
                            }
                        } catch (error) {
                            logger.error(`Failed to send the synthetic user message for session ${sessionId}`, error);
                        }
                    },
                    onTurnAdopted: () => {
                        turnWasAdopted = true;
                    },
                    onTurnStarted: (turn) => {
                        startedTurn = turn;
                    },
                }, reservation);
            };
            run().then(
                async (response) => {
                    this.v2PromptsInFlight.delete(sessionId);
                    if (!inserted) {
                        const notInsertedMessage = "The prompt ended before Codex recorded the user message";
                        // A `cancelled` v1 stop reason means the adopted turn was interrupted
                        // (e.g. by `session/cancel`) before this prompt's input landed: it was
                        // never inserted, so it is dropped with `-32800` like a queued prompt.
                        reject(response.stopReason === "cancelled"
                            ? RequestError.requestCancelled(undefined, notInsertedMessage)
                            : RequestError.internalError(undefined, notInsertedMessage));
                        // Codex dropped the steered input before the adopted turn ended: that
                        // turn's `running` still needs exactly one matching `idle`, and nothing
                        // else will send it now that this prompt is no longer in flight.
                        if (turnWasAdopted) {
                            await sendState(toV2IdleState(response));
                        }
                        return;
                    }
                    if (running !== null) {
                        await running;
                    }
                    // The session takes the next prompt before `idle` goes out, so a client that
                    // prompts again as soon as it sees `idle` is not rejected as overlapping.
                    // What v1 would have answered with ends the v2 turn.
                    await sendState(toV2IdleState(response));
                },
                async (error: unknown) => {
                    if (!inserted) {
                        this.v2PromptsInFlight.delete(sessionId);
                        reject(error);
                        if (turnWasAdopted) {
                            await sendState(toV2IdleState(this.failedPromptResponse(sessionId)));
                        }
                        return;
                    }
                    // Past insertion the request is answered, so the failure is told as agent
                    // text (unless the turn already sent it) and the turn still ends with `idle`.
                    logger.error(`Prompt for session ${sessionId} failed after it was inserted`, error);
                    if (running !== null) {
                        await running;
                    }
                    if (!failureWasShownAsMessage(error)) {
                        try {
                            await session.update({sessionUpdate: "session_info_update", _meta: {codex: {error: {
                                message: sanitizeProviderErrorText(postInsertionFailureText(error, promptKind.kind === "localCommand" ? promptKind.name : undefined)),
                            }}}});
                        } catch (sendError) {
                            logger.error(`Failed to send the prompt failure for session ${sessionId}`, sendError);
                        }
                    }
                    this.v2PromptsInFlight.delete(sessionId);
                    await sendState(toV2IdleState(this.failedPromptResponse(sessionId)));
                },
            ).finally(() => {
                signal?.removeEventListener("abort", dropPendingRequest);
                reservation.release();
            });
        });
    }

    async prompt(
        params: acp.PromptRequest,
        signal?: AbortSignal,
        onTurnStarted?: () => void,
        insertion?: UserMessageInsertion,
        reservation?: TurnStartReservation,
    ): Promise<acp.PromptResponse> {
        // Callers that need to gate additional checks (closing, canStart) atomically with the
        // turn-start slot acquire their own reservation and pass it in; otherwise this call is
        // the v1 entry point and takes the session's turn-start slot itself.
        if (this.protocolVersion === 1 && reservation === undefined &&
            (this.activePrompts.has(params.sessionId) || this.turnStartQueueTail.get(params.sessionId)?.settled === false)) {
            throw RequestError.invalidRequest("A Codex prompt is already active; use the advertised steer extension");
        }
        const ownsReservation = reservation === undefined;
        const activeReservation = reservation ?? this.acquireTurnStartReservation(params.sessionId);
        if (activeReservation.needsWait) {
            await activeReservation.wait;
        }
        try {
            return await this.promptAfterReservation(params, signal, onTurnStarted, insertion);
        } finally {
            if (ownsReservation) {
                activeReservation.release();
            }
        }
    }

    private async promptAfterReservation(
        params: acp.PromptRequest,
        signal?: AbortSignal,
        onTurnStarted?: () => void,
        insertion?: UserMessageInsertion,
    ): Promise<acp.PromptResponse> {
        if (this.providerUpdate !== null) {
            await this.providerUpdate;
        }
        if (this.activePrompts.has(params.sessionId)) {
            throw RequestError.invalidRequest(
                "A Codex prompt is already active; use the advertised steer extension",
            );
        }
        logger.log("Prompt received", {
            sessionId: params.sessionId,
            prompt: params.prompt,
        });
        const sessionState = this.getSessionState(params.sessionId);
        const agentFileChangeReportRequest = clientSupportsAgentFileChangeReports(this.clientCapabilities)
            ? parseAgentFileChangeReportRequest(params._meta)
            : null;
        const goalPromptControl = parseGoalPromptControl(params._meta);
        const agentFileChangeWorkspace = agentFileChangeReportRequest === null
            ? null
            : captureAgentFileChangeWorkspace(sessionState.cwd, sessionState.additionalDirectories);
        let agentFileChangeReportTurnId: string | null = null;
        let agentFileChangeReportUnavailableReason: AgentFileChangeReportUnavailableReason = "providerError";
        let promptWasCancelled = false;
        let recoverableSessionFailure = sessionState.sessionFailure;
        sessionState.currentTurnId = null;
        sessionState.interruptTurnId = null;
        const activePrompt = this.trackActivePrompt(params.sessionId);
        const goalLifecycle = new GoalPromptLifecycle(params.sessionId, sessionState.currentGoal?.status === "active");
        const cancelGoalLifecycle = () => goalLifecycle.cancel();
        activePrompt.signal.addEventListener("abort", cancelGoalLifecycle);
        const disposeGoalConnection = this.codexAcpClient.onConnectionClosed(() => {
            goalLifecycle.fail(new Error("Codex connection closed during goal continuation"));
        });
        let pendingTurnStart: PendingTurnStart | null = null;
        const ensurePendingTurnStart = (): PendingTurnStart => {
            if (pendingTurnStart === null) {
                pendingTurnStart = this.createPendingTurnStart();
                this.pendingTurnStarts.set(params.sessionId, pendingTurnStart);
            }
            return pendingTurnStart;
        };
        const disposePromptRequestCancellation = this.observePromptRequestCancellation(signal, sessionState, activePrompt);
        let eventHandler: CodexEventHandler | null = null;
        let promptNotificationsActive = true;
        let pendingInsertion = insertion;
        // Synthetic turns codex-acp starts itself inside this same prompt (the plan-implementation
        // follow-up, a `/goal` continuation) each mint their own id and register here, so their
        // userMessage can be told apart from the original prompt's once it lands.
        const pendingSyntheticInsertions = new Map<string, () => Promise<void>>();
        const registerSyntheticInsertion = (clientUserMessageId: string, prompt: acp.ContentBlock[]): void => {
            if (insertion === undefined) {
                return;
            }
            pendingSyntheticInsertions.set(clientUserMessageId, () => insertion.onSyntheticInserted(clientUserMessageId, prompt));
        };
        const clearRecoveredSessionFailure = async (handler: CodexEventHandler): Promise<void> => {
            await handler.completeSuccessfulTurn(sessionState.currentTurnId);
            const current = sessionState.sessionFailure;
            if (recoverableSessionFailure !== undefined
                && current !== undefined
                && current.id === recoverableSessionFailure.id
                && current.revision === recoverableSessionFailure.revision) {
                await handler.clearSessionFailure();
            }
        };
        const cancelledPromptResponse = (): acp.PromptResponse => {
            promptWasCancelled = true;
            agentFileChangeReportTurnId = null;
            agentFileChangeReportUnavailableReason = "cancelled";
            return this.cancelledPromptResponse(sessionState);
        };

        try {
            sessionState.turnUsage ??= new CodexTurnUsage(false,
                this.codexAcpClient.appServerClient.getThreadTokenUsage(params.sessionId)?.tokenUsage.total);
            sessionState.turnUsage.prepare(ModelId.fromString(sessionState.currentModelId).model);
            const promptEventHandler = new CodexEventHandler(
                this.connection,
                sessionState,
                clientSupportsTypedSessionFailures(this.clientCapabilities),
                this.sessionFailureEpoch,
                sessionState.subagents,
                (accountUpdated) => this.handleAccountUpdated(accountUpdated),
                agentFileChangeReportRequest !== null,
                clientSupportsCompaction(this.clientCapabilities),
                clientSupportsNotices(this.clientCapabilities),
            );
            eventHandler = promptEventHandler;
            const permissionLifecycle = this.permissionLifecycleContext(sessionState);
            const permissionContext = permissionLifecycle.beginPrompt();
            const toolCallRenderer = new AcpToolCallRenderer(this.capabilities);
            const approvalHandler = new CodexApprovalHandler(
                sessionState.subagents.connectionForEvents(this.connection),
                permissionContext,
                activePrompt.interactionSignal,
                toolCallRenderer,
            );
            const elicitationHandler = new CodexElicitationHandler(
                sessionState.subagents.connectionForEvents(this.connection),
                permissionContext,
                this.clientCapabilities,
                activePrompt.interactionSignal,
                toolCallRenderer,
            );
            const observeInteraction = async (event: ServerNotification): Promise<void> => {
                permissionContext.handleNotification(event);
                await elicitationHandler.handleNotification(event);
            };
            const resolvePendingInsertion = async (): Promise<void> => {
                if (pendingInsertion === undefined) {
                    return;
                }
                const {onInserted} = pendingInsertion;
                pendingInsertion = undefined;
                await onInserted();
            };
            await this.codexAcpClient.subscribeToSessionEvents(params.sessionId,
                async (event) => {
                    if (this.activePrompts.get(params.sessionId) === activePrompt) {
                        goalLifecycle.observe(event);
                        if (event.method === "turn/started" && event.params.threadId === params.sessionId) {
                            const turn = {threadId: params.sessionId, turnId: event.params.turn.id};
                            this.setActivePromptTurn(activePrompt, turn);
                            if (this.promptShouldStop(params.sessionId, activePrompt)) {
                                this.interruptLateStartedTurn(sessionState, turn, activePrompt);
                                return;
                            }
                            recoverableSessionFailure = sessionState.sessionFailure;
                            promptNotificationsActive = true;
                        }
                        if (event.method === "turn/completed" &&
                            event.params.threadId === params.sessionId &&
                            activePrompt.currentTurn?.threadId === event.params.threadId &&
                            activePrompt.currentTurn.turnId === event.params.turn.id) {
                            activePrompt.currentTurn = null;
                            activePrompt.hasCompletedTurn = true;
                        }
                    }
                    await this.handleSteerAppliedNotification(params.sessionId, event, activePrompt);
                    // Tracks turns this prompt doesn't own too (a `/goal` continuation after this
                    // prompt's own turn already went idle): the same subscription keeps receiving
                    // notifications for as long as no later prompt replaces it.
                    await this.trackCodexTurnStart(sessionState, event);
                    await this.trackSteerLanding(sessionState, event);
                    if (pendingInsertion !== undefined
                        && isInsertedUserMessage(event, params.sessionId, pendingInsertion.clientUserMessageId)) {
                        await resolvePendingInsertion();
                    } else {
                        for (const [clientUserMessageId, resolveSynthetic] of pendingSyntheticInsertions) {
                            if (isInsertedUserMessage(event, params.sessionId, clientUserMessageId)) {
                                pendingSyntheticInsertions.delete(clientUserMessageId);
                                await resolveSynthetic();
                                break;
                            }
                        }
                    }
                    await observeInteraction(event);
                    if (!promptNotificationsActive) {
                        await promptEventHandler.handleSessionScopedNotification(event);
                        await this.trackCodexTurnCompletion(sessionState, event);
                        return;
                    }
                    const completesActiveTurn = event.method === "turn/completed"
                        && event.params.threadId === sessionState.sessionId
                        && activePrompt.currentTurn?.threadId === event.params.threadId
                        && activePrompt.currentTurn.turnId === event.params.turn.id;
                    await promptEventHandler.handleNotification(event);
                    if (completesActiveTurn) {
                        // The prompt may remain open for plan approval after its turn has ended. Switch at
                        // the causal boundary so a queued late error cannot enter the completed turn's buffer.
                        promptNotificationsActive = false;
                    }
                    await this.trackCodexTurnCompletion(sessionState, event);
                },
                approvalHandler,
                elicitationHandler,
                clientSupportsSubagents(this.clientCapabilities),
                observeInteraction,
                childThreadId => promptEventHandler.waitForNativeSubagentSession(childThreadId));

            if (activePrompt.signal.aborted) {
                return cancelledPromptResponse();
            }

            const commandOptions: CommandHandleOptions = {
                onTurnStartPending: () => {
                    sessionState.lastTokenUsage = null;
                    ensurePendingTurnStart();
                },
                onTurnStarted: (turnId, threadId) => {
                    const turn = {threadId, turnId};
                    if (threadId === params.sessionId) goalLifecycle.startTurn(turnId);
                    this.setActivePromptTurn(activePrompt, turn);
                    insertion?.onTurnStarted?.(turn);
                    if (this.promptShouldStop(params.sessionId, activePrompt)) {
                        this.interruptLateStartedTurn(sessionState, turn, activePrompt);
                        return;
                    }
                    sessionState.currentTurnId = turnId;
                    pendingTurnStart?.resolve(turnId);
                    onTurnStarted?.();
                },
                onNativeCommandStarted: () => {
                    activePrompt.nativeCommandInFlight = true;
                },
                onNativeCommandFinished: () => {
                    activePrompt.nativeCommandInFlight = false;
                },
                ...(insertion === undefined ? {} : {
                    onCommandAccepted: () => {
                        void resolvePendingInsertion();
                    },
                }),
                setConfigOption: async (configId, value) => {
                    await this.applySessionConfigOption(sessionState, {
                        sessionId: sessionState.sessionId,
                        configId,
                        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
                    });
                    const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
                    await session.update({
                        sessionUpdate: "config_option_update",
                        configOptions: this.createSessionConfigOptions(sessionState),
                    });
                },
            };
            // A goal action carried by prompt metadata is the same operation as
            // its slash command, minus the command text in the transcript.
            const commandPromise = goalPromptControl === null
                ? this.availableCommands.tryHandleCommand(params.prompt, sessionState, commandOptions)
                : this.availableCommands.runGoalPromptControl(sessionState, goalPromptControl, commandOptions);
            void commandPromise.catch((err) => {
                if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                    logger.error(`Command for cancelled prompt ${params.sessionId} failed after prompt returned`, err);
                }
            });
            let commandResult = await Promise.race([
                commandPromise,
                activePrompt.closeSignal,
                this.cancelBeforeTurnStarted(activePrompt),
            ]);
            if (commandResult === null) {
                return cancelledPromptResponse();
            }
            if (commandResult.handled) {
                if (this.protocolVersion === 1 && commandResult.turnCompleted && commandResult.waitForGoalContinuation !== false) {
                    await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    const firstCommandTurn = commandResult.turnCompleted;
                    const completed = await this.runWithProcessCheck(() => Promise.race([
                        goalLifecycle.waitForCompletion(firstCommandTurn), activePrompt.closeSignal,
                    ]));
                    if (completed === null) return cancelledPromptResponse();
                    commandResult = {...commandResult, turnCompleted: completed};
                }
                promptNotificationsActive = false;
                logger.log("Prompt handled by a command");
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                await eventHandler.flushPendingErrors();
                await eventHandler.flushPendingErrorsAsSessionScoped();
                if (commandResult.turnCompleted) {
                    await eventHandler.handleFailedTurn(commandResult.turnCompleted.turn);
                }
                if (commandResult.turnCompleted?.turn.status === "interrupted") {
                    return cancelledPromptResponse();
                }
                const error = eventHandler.getFailure();
                if (error) {
                    // noinspection ExceptionCaughtLocallyJS
                    throw error;
                }
                const terminalFailure = this.terminalFailurePromptResponse(
                    sessionState,
                    eventHandler,
                    commandResult.turnCompleted?.turn.id ?? sessionState.currentTurnId,
                );
                if (terminalFailure) {
                    return terminalFailure;
                }
                if (commandResult.turnCompleted?.turn.status === "completed") {
                    agentFileChangeReportTurnId = commandResult.turnCompleted.turn.id;
                } else if (commandResult.turnCompleted === undefined) {
                    agentFileChangeReportUnavailableReason = "notReported";
                }
                await clearRecoveredSessionFailure(eventHandler);
                return {
                    stopReason: "end_turn",
                    usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                    _meta: this.buildQuotaMeta(sessionState),
                };
            }

            if (this.sessionIsClosing(params.sessionId)) {
                return cancelledPromptResponse();
            }

            const promptInput = commandResult.prompt ?? params.prompt;
            const modelId = ModelId.fromString(sessionState.currentModelId);
            const modelLacksReasoning = sessionState.supportedReasoningEfforts.length > 0
                && sessionState.supportedReasoningEfforts.every(e => e.reasoningEffort === "none");

            const disableSummary = sessionState.account?.type === "apiKey" || modelLacksReasoning;
            if (disableSummary) {
                logger.log("Disable reasoning.summary", {
                    sessionId: params.sessionId,
                    reason: sessionState.account?.type === "apiKey" ? "API key" : "model lacks reasoning"
                });
            }

            if (!sessionState.supportedInputModalities.includes("image") && params.prompt.some(b => b.type === "image")) {
                throw RequestError.invalidRequest("The current model does not support image input");
            }
            const agentMode = sessionState.agentMode;
            const serviceTier = resolveFastServiceTier(
                sessionState.fastModeEnabled,
                sessionState.currentModelSupportsFast,
            );
            sessionState.lastTokenUsage = null;
            ensurePendingTurnStart();
            goalLifecycle.prepareTurn();
            sessionState.turnUsage.prepare(modelId.model);
            // Snapshot right before dispatch (no await in between): if a turn is already
            // running here, it is unowned (this prompt hasn't started one yet) and already sent
            // its own `running`.
            const priorRunningTurnId = sessionState.codexReportedRunningTurnId;
            const sendPromptPromise = this.runWithProcessCheck(
                () => this.codexAcpClient.sendPrompt(
                    {...params, prompt: promptInput},
                    agentMode,
                    modelId,
                    serviceTier,
                    disableSummary,
                    sessionState.cwd,
                    sessionState.additionalDirectories,
                    (turnId) => {
                        const turn = {threadId: params.sessionId, turnId};
                        if (!goalLifecycle.startSubmittedTurn(turnId)) {
                            pendingTurnStart?.resolve(turnId);
                            onTurnStarted?.();
                            return;
                        }
                        this.setActivePromptTurn(activePrompt, turn);
                        insertion?.onTurnStarted?.(turn);
                        if (this.promptShouldStop(params.sessionId, activePrompt)) {
                            this.interruptLateStartedTurn(sessionState, turn, activePrompt);
                            return;
                        }
                        sessionState.currentTurnId = turnId;
                        pendingTurnStart?.resolve(turnId);
                        if (priorRunningTurnId !== null && turnId === priorRunningTurnId) {
                            insertion?.onTurnAdopted?.();
                        }
                        onTurnStarted?.();
                    },
                    () => this.promptShouldStop(params.sessionId, activePrompt),
                    insertion?.clientUserMessageId,
                ));
            void sendPromptPromise.catch((err) => {
                if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                    logger.error(`Prompt for cancelled session ${params.sessionId} failed after prompt returned`, err);
                }
            });
            let turnCompleted = await Promise.race([
                sendPromptPromise,
                activePrompt.closeSignal,
                this.cancelBeforeTurnStarted(activePrompt),
            ]);

            if (turnCompleted === null) {
                return cancelledPromptResponse();
            }

            await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            const firstPromptTurn = turnCompleted;
            if (this.protocolVersion === 1) turnCompleted = await this.runWithProcessCheck(() => Promise.race([
                goalLifecycle.waitForCompletion(firstPromptTurn), activePrompt.closeSignal,
            ]));
            if (turnCompleted === null) return cancelledPromptResponse();
            await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            if (turnCompleted.turn.status === "completed") {
                await eventHandler.waitForNativeSubagents(activePrompt.signal);
                if (activePrompt.signal.aborted) return cancelledPromptResponse();
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
            }
            else {
                await eventHandler.finishOutstandingNativeSubagents(
                    turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                );
            }
            await eventHandler.flushPendingErrors();
            await eventHandler.handleFailedTurn(turnCompleted.turn);
            promptNotificationsActive = false;

            if (turnCompleted.turn.status === "interrupted") {
                await eventHandler.flushPendingPlanUpdates();
                return cancelledPromptResponse();
            }

            const error = eventHandler.getFailure();
            if (error) {
                // noinspection ExceptionCaughtLocallyJS
                throw error;
            }
            const terminalFailure = this.terminalFailurePromptResponse(
                sessionState,
                eventHandler,
                turnCompleted.turn.id,
            );
            if (terminalFailure) {
                return terminalFailure;
            }

            await eventHandler.flushPendingPlanUpdates();
            const completedPlan = eventHandler.takeCompletedPlan();
            if (
                completedPlan !== null
                && sessionState.collaborationMode === PLAN_COLLABORATION_MODE
                && !this.promptShouldStop(params.sessionId, activePrompt)
            ) {
                const approved = await this.requestPlanImplementationPermission(
                    sessionState,
                    completedPlan,
                    activePrompt.interactionSignal,
                );
                // `cancelRequested` catches plain `session/cancel`, which doesn't abort `signal`
                // (that would also change pre-turn prompt flow); without it this branch would
                // fall through to `end_turn` instead of `cancelled`.
                if (this.promptShouldStop(params.sessionId, activePrompt) || activePrompt.cancelRequested) {
                    return cancelledPromptResponse();
                }
                if (approved && !this.promptShouldStop(params.sessionId, activePrompt)) {
                    await this.applyCollaborationModeChange(sessionState, DEFAULT_COLLABORATION_MODE);
                    const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
                    await session.update({
                        sessionUpdate: "config_option_update",
                        configOptions: this.createSessionConfigOptions(sessionState),
                    });

                    const implementationRequest: acp.PromptRequest = {
                        sessionId: params.sessionId,
                        prompt: [{type: "text", text: "Implement the approved plan."}],
                    };
                    activePrompt.currentTurn = null;
                    sessionState.currentTurnId = null;
                    goalLifecycle.prepareTurn();
                    sessionState.turnUsage.prepare(modelId.model);
                    sessionState.interruptTurnId = null;
                    // This second turn stays inside the original prompt's running…idle pair, so it
                    // gets its own minted id rather than reusing the first turn's.
                    const implementationClientUserMessageId = insertion !== undefined ? randomUUID() : undefined;
                    if (implementationClientUserMessageId !== undefined) {
                        registerSyntheticInsertion(implementationClientUserMessageId, implementationRequest.prompt);
                    }
                    const implementationPromise = this.runWithProcessCheck(
                        () => this.codexAcpClient.sendPrompt(
                            implementationRequest,
                            agentMode,
                            modelId,
                            serviceTier,
                            disableSummary,
                            sessionState.cwd,
                            sessionState.additionalDirectories,
                            (turnId) => {
                                const turn = {threadId: params.sessionId, turnId};
                                if (!goalLifecycle.startSubmittedTurn(turnId)) return;
                                this.setActivePromptTurn(activePrompt, turn);
                                if (this.promptShouldStop(params.sessionId, activePrompt)) {
                                    this.interruptLateStartedTurn(sessionState, turn, activePrompt);
                                    return;
                                }
                                sessionState.currentTurnId = turnId;
                                // Keep the approval-to-turn-start gap session-scoped. Once the new turn has
                                // an identity, snapshot any unchanged session failure as its recovery baseline.
                                recoverableSessionFailure = sessionState.sessionFailure;
                                promptNotificationsActive = true;
                            },
                            () => this.promptShouldStop(params.sessionId, activePrompt),
                            implementationClientUserMessageId,
                        ),
                    );
                    void implementationPromise.catch((err) => {
                        if (this.activePrompts.get(params.sessionId) !== activePrompt) {
                            logger.error(`Implementation turn for cancelled prompt ${params.sessionId} failed after prompt returned`, err);
                        }
                    });
                    turnCompleted = await Promise.race([
                        implementationPromise,
                        activePrompt.closeSignal,
                        this.cancelBeforeTurnStarted(activePrompt),
                    ]);

                    if (turnCompleted === null) {
                        return cancelledPromptResponse();
                    }

                    await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    const firstImplementationTurn = turnCompleted;
                    turnCompleted = await this.runWithProcessCheck(() => Promise.race([
                        goalLifecycle.waitForCompletion(firstImplementationTurn), activePrompt.closeSignal,
                    ]));
                    if (turnCompleted === null) return cancelledPromptResponse();
                    await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    if (turnCompleted.turn.status === "completed") {
                        await eventHandler.waitForNativeSubagents(activePrompt.signal);
                        if (activePrompt.signal.aborted) return cancelledPromptResponse();
                        await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                    }
                    else {
                        await eventHandler.finishOutstandingNativeSubagents(
                            turnCompleted.turn.status === "interrupted" ? "cancelled" : "failed",
                        );
                    }
                    await eventHandler.flushPendingErrors();
                    await eventHandler.handleFailedTurn(turnCompleted.turn);
                    promptNotificationsActive = false;
                    if (turnCompleted.turn.status === "interrupted") {
                        await eventHandler.flushPendingPlanUpdates();
                        return cancelledPromptResponse();
                    }

                    const implementationError = eventHandler.getFailure();
                    if (implementationError) {
                        throw implementationError;
                    }
                    const implementationFailure = this.terminalFailurePromptResponse(
                        sessionState,
                        eventHandler,
                        turnCompleted.turn.id,
                    );
                    if (implementationFailure) {
                        return implementationFailure;
                    }
                }
            }
            if (turnCompleted.turn.status === "completed") {
                agentFileChangeReportTurnId = turnCompleted.turn.id;
            }

            await clearRecoveredSessionFailure(eventHandler);

            // Codex sends no notification for a new skill file. A skill that appeared during the turn becomes a
            // slash command after it. Never await: the prompt response does not wait for the skill list.
            void this.availableCommands.publish(
                sessionState,
                undefined,
                () => this.sessions.get(sessionState.sessionId) === sessionState,
                true,
            );

            // On v2, a prompt whose user message was never recorded (`pendingInsertion` still set)
            // never happened from the client's view, so it must not leave a title behind either.
            if (pendingInsertion === undefined) {
                await this.publishFallbackSessionTitle(
                    sessionState,
                    this.createPromptFallbackTitle(params.prompt),
                );
            }

            return {
                stopReason: "end_turn",
                usage: this.buildPromptUsage(sessionState.lastTokenUsage),
                _meta: this.buildQuotaMeta(sessionState),
            };
        } catch (err) {
            logger.error(`Prompt for session ${params.sessionId} failed`, err);
            if (activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)) {
                return cancelledPromptResponse();
            }
            agentFileChangeReportTurnId = null;
            agentFileChangeReportUnavailableReason = "providerError";
            const isProcessExit = err instanceof RequestError
                && err.code === CODEX_PROCESS_EXITED_ERROR_CODE;
            const isUnexpectedFailure = !(err instanceof RequestError);
            if (eventHandler !== null
                && clientSupportsTypedSessionFailures(this.clientCapabilities)
                && (isProcessExit || isUnexpectedFailure)) {
                eventHandler.recordSyntheticTerminalFailure(
                    isProcessExit ? "transport_lost" : "internal_error",
                    sessionState.currentTurnId,
                );
                const failureResponse = this.terminalFailurePromptResponse(
                    sessionState,
                    eventHandler,
                    sessionState.currentTurnId,
                    true,
                );
                if (failureResponse !== null) {
                    return failureResponse;
                }
            }
            throw err;
        } finally {
            // A cancelled v1 prompt must not leave Codex's idle goal scheduler
            // starting more foreground turns after the response is returned.
            if ((promptWasCancelled || activePrompt.signal.aborted) && sessionState.currentGoal?.status === "active") {
                try {
                    const goal = await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(params.sessionId, "paused"));
                    await this.publishGoalSnapshot(sessionState, toThreadGoalSnapshot(goal), false);
                } catch (error) {
                    logger.error("Failed to pause goal after prompt cancellation", error);
                }
            }
            // The app-server subscription is session-scoped and outlives this prompt. Flip routing before
            // awaiting disposal so queued late notifications cannot enter prompt-local buffers.
            promptNotificationsActive = false;
            try {
                await this.codexAcpClient.waitForSessionNotifications(params.sessionId);
                await eventHandler?.finishOutstandingNativeSubagents(
                    promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)
                        ? "cancelled"
                        : "failed",
                );
            } catch (error) {
                logger.error("Failed to publish terminal compaction or subagent state during prompt cleanup", error);
            }
            if (agentFileChangeReportRequest !== null && agentFileChangeWorkspace !== null) {
                if (promptWasCancelled || activePrompt.signal.aborted || this.sessionIsClosing(params.sessionId)) {
                    agentFileChangeReportTurnId = null;
                    agentFileChangeReportUnavailableReason = "cancelled";
                } else if (agentFileChangeReportTurnId !== null
                    && eventHandler?.isTurnDiffOversized(agentFileChangeReportTurnId)) {
                    agentFileChangeReportTurnId = null;
                    agentFileChangeReportUnavailableReason = "invalidOutput";
                }
                await this.publishAgentFileChangeReport(
                    sessionState,
                    agentFileChangeReportTurnId,
                    agentFileChangeReportRequest,
                    agentFileChangeReportUnavailableReason,
                    agentFileChangeReportTurnId === null || eventHandler === null
                        ? ""
                        : eventHandler.getTurnDiff(agentFileChangeReportTurnId),
                    agentFileChangeWorkspace,
                );
            }
            logger.log("Prompt completed", {sessionId: params.sessionId});
            await eventHandler?.dispose();
            disposeGoalConnection();
            goalLifecycle.fail(new Error("ACP prompt closed"));
            activePrompt.signal.removeEventListener("abort", cancelGoalLifecycle);
            disposePromptRequestCancellation();
            sessionState.currentTurnId = null;
            sessionState.interruptTurnId = null;
            const registeredPendingTurnStart = this.pendingTurnStarts.get(params.sessionId);
            if (registeredPendingTurnStart !== undefined) {
                this.pendingTurnStarts.delete(params.sessionId);
                registeredPendingTurnStart.resolve(null);
            }
            activePrompt.complete();
        }
    }

    private async requestPlanImplementationPermission(
        sessionState: SessionState,
        plan: CompletedPlan,
        cancellationSignal: AbortSignal,
    ): Promise<boolean> {
        const renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        try {
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                PlanReviewReporter.permissionRequest(sessionState.sessionId, plan, renderer),
                {cancellationSignal},
            );
            const approved = PlanReviewReporter.approved(response);
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId: sessionState.sessionId,
                update: renderer.render(PlanReviewReporter.decided(plan, approved)),
            });
            return approved;
        } catch (error) {
            logger.error("Error requesting plan implementation permission", error);
            return false;
        }
    }

    private cancelledPromptResponse(sessionState: SessionState): acp.PromptResponse {
        return {
            stopReason: "cancelled",
            usage: this.buildPromptUsage(sessionState.lastTokenUsage),
            _meta: this.buildQuotaMeta(sessionState),
        };
    }

    /** The v1-shaped result of a prompt that failed after insertion, for its v2 `idle`. */
    private failedPromptResponse(sessionId: string): acp.PromptResponse {
        const sessionState = this.sessions.get(sessionId);
        if (sessionState === undefined) {
            return {stopReason: "end_turn"};
        }
        return {
            stopReason: "end_turn",
            usage: this.buildPromptUsage(sessionState.lastTokenUsage),
            _meta: this.buildQuotaMeta(sessionState),
        };
    }

    private terminalFailurePromptResponse(
        sessionState: SessionState,
        eventHandler: CodexEventHandler,
        turnId: string | null,
        allowUnattributed = false,
    ): acp.PromptResponse | null {
        const failureMeta = eventHandler.getTerminalSessionFailureMeta(turnId, allowUnattributed);
        if (failureMeta === null) {
            return null;
        }
        return {
            stopReason: "end_turn",
            usage: this.buildPromptUsage(sessionState.lastTokenUsage),
            _meta: {
                ...this.buildQuotaMeta(sessionState),
                ...failureMeta,
            },
        };
    }

    private buildQuotaMeta(sessionState: SessionState): { quota: QuotaMeta } {
        const lastTokenUsage = sessionState.lastTokenUsage;

        // Remove the "[reasoning-level]" suffix from currentModelId if present
        const modelName = sessionState.currentModelId.replace(/\[.*?]$/, '');

        // FIXME: currently all tokens are reported for the current model
        const modelUsage = (lastTokenUsage != null)
            ? [{ model: modelName, token_count: lastTokenUsage }]
            : [];

        return {
            quota: {
                token_count: sessionState.lastTokenUsage,
                model_usage: modelUsage
            },
        };
    }

    private buildPromptUsage(lastTokenUsage: TokenCount | null): acp.Usage | null {
        if (lastTokenUsage == null) {
            return null;
        }
        return toPromptUsage(lastTokenUsage);
    }

    private async runWithProcessCheck<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (err) {
            const exitCode = this.getExitCode();
            const requestErrorCode = CODEX_PROCESS_EXITED_ERROR_CODE;
            if (exitCode == 3221225781) {
                throw new RequestError(requestErrorCode, `VC++ redistributable should be installed`);
            }
            if (exitCode !== null) {
                await this.finishAllAsyncTasks("failed", "after the Codex process exited");
                const stderr = this.getRecentStderr().trim();
                const detail = stderr ? `:\n${stderr}` : "";
                throw new RequestError(requestErrorCode, `Codex process has exited with code ${exitCode}${detail}`);
            }
            throw err;
        }
    }

    private async finishAllAsyncTasks(state: "failed" | "stopped", reason: string): Promise<void> {
        for (const session of this.sessions.values()) {
            try {
                await session.asyncTasks.finishAll(state);
            } catch (error) {
                logger.error(`Failed to finish background terminal tasks ${reason}`, error);
            }
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        const sessionState = this.sessions.get(params.sessionId);
        if (!sessionState) {
            logger.log("Cancel request rejected: session not found", {sessionId: params.sessionId});
            return;
        }

        const activePrompt = this.activePrompts.get(params.sessionId);
        if (activePrompt?.nativeCommandInFlight) {
            activePrompt.requestCancel();
            // A submitted native command owns the prompt before its turn id arrives.
            // The turn-start callback interrupts it when the id becomes available.
            if (activePrompt.currentTurn === null) return;
        }
        // There may be no native turn in the gap before automatic continuation.
        // Abort the owning prompt without interrupting its already-completed turn.
        if (activePrompt?.hasCompletedTurn && activePrompt.currentTurn === null) {
            activePrompt.requestCancel();
            return;
        }
        if (activePrompt?.currentTurn) activePrompt.requestCancel();
        // Abort outbound permission/elicitation requests synchronously, before awaiting the turn
        // interrupt below (which can itself wait on a pending turn start). Mark cancelRequested so
        // the plan-review branch can detect this cancellation even though it doesn't abort `signal`.
        if (activePrompt) {
            activePrompt.cancelRequested = true;
            activePrompt.abortInteractions();
        }

        // Drop every v2 prompt still queued (not yet inserted) before interrupting the running
        // turn, so their `-32800` responses do not wait on the interrupt completing. No-op on v1.
        this.cancelQueuedV2Prompts(params.sessionId);
        // After turnInterrupt(), Codex will send turn/completed, which naturally completes awaitTurnCompleted().
        await this.interruptSessionTurn(sessionState, "Cancel", false);
    }
}

/** A buffered reviewer prompt candidate is shown once its turn has this many items. */
const REVIEWER_PROMPT_CANDIDATE_MAX_ITEMS = 100;

/**
 * The items of `pages` without the reviewer prompts of `/review` runs (user decision: v2 only, v1
 * keeps showing them). A `/review` run persists its reviewer prompt as the first item of its own
 * turn T, which Codex lists just before the review turn P (P's first item is `enteredReviewMode`).
 * T is never shown live, and there is no way to distinguish it from an ordinary preceding turn
 * except that T is minted *after* P: its UUIDv7 turn id sorts higher. Only a turn that can be T is
 * held back, until the first item of the next turn decides.
 */
async function* withoutReviewerPrompts(pages: AsyncIterable<ThreadItemEntry[]>): AsyncGenerator<ThreadItem[]> {
    let turnId: string | null = null;
    let candidate: {turnId: string; items: ThreadItem[]} | null = null;
    for await (const page of pages) {
        const items: ThreadItem[] = [];
        for (const entry of page) {
            const item = entry.item;
            const turnStarts = entry.turnId !== turnId;
            turnId = entry.turnId;
            if (candidate !== null && turnStarts) {
                const hidden = item.type === "enteredReviewMode"
                    && isUuidV7(candidate.turnId) && isUuidV7(entry.turnId) && candidate.turnId > entry.turnId;
                items.push(...(hidden ? candidate.items.slice(1) : candidate.items));
                candidate = null;
            }
            if (turnStarts && item.type === "userMessage" && item.clientId === null) {
                candidate = {turnId: entry.turnId, items: [item]};
                continue;
            }
            if (candidate === null) {
                items.push(item);
                continue;
            }
            candidate.items.push(item);
            // A turn with its own messages is not a reviewer prompt turn.
            if (item.type === "agentMessage" || item.type === "userMessage"
                || candidate.items.length >= REVIEWER_PROMPT_CANDIDATE_MAX_ITEMS) {
                items.push(...candidate.items);
                candidate = null;
            }
        }
        if (items.length > 0) yield items;
    }
    if (candidate !== null) yield candidate.items;
}

/** The items of the entry pages of `pages`. */
async function* itemsOfEntries(pages: AsyncIterable<ThreadItemEntry[]>): AsyncGenerator<ThreadItem[]> {
    for await (const page of pages) {
        yield page.map(entry => entry.item);
    }
}

function isUuidV7(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The whole-message kind a replayed chunk update restarts, or `null` if it isn't a chunk. */
function replayMessageStartKind(sessionUpdate: UpdateSessionEvent["sessionUpdate"]): ReplayMessageKind | null {
    switch (sessionUpdate) {
        case "user_message_chunk":
            return "user_message";
        case "agent_message_chunk":
            return "agent_message";
        case "agent_thought_chunk":
            return "agent_thought";
        default:
            return null;
    }
}

function getRequestedMcpServerNames(mcpServers: Array<AcpMcpServer>): Array<string> {
    return Array.from(new Set(mcpServers.map(server => sanitizeMcpServerName(getMcpServerName(server)))));
}

const MCP_STARTUP_AWAIT_TIMEOUT_META_KEY = "mcpStartupAwaitTimeoutMs";

function parseMcpStartupAwaitTimeoutMs(meta: Record<string, unknown> | null | undefined): number | undefined {
    const value = meta?.[MCP_STARTUP_AWAIT_TIMEOUT_META_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Resolves once `startup` settles, or once `timeoutMs` elapses, whichever comes first.
// A startup rejection is only propagated if it happens before the timeout.
function raceMcpStartupTimeout(startup: Promise<McpStartupResult>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve();
            }
        }, timeoutMs);
        startup.then(
            () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve();
                }
            },
            (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(err);
                }
            },
        );
    });
}

/** A close of the session stopped the read of its history during `session/load`. */
class SessionClosedDuringLoadError extends Error {
    constructor() {
        super("The session closed during the history load");
    }
}

/** The pages of `pages` while `isOpen` is true. A close of the session stops the read at the next page. */
async function* untilSessionClose<T>(pages: AsyncIterable<T[]>, isOpen: () => boolean): AsyncGenerator<T[]> {
    for await (const page of pages) {
        if (!isOpen()) throw new SessionClosedDuringLoadError();
        yield page;
    }
}

/** The page `first`, then the pages of `rest`. */
async function* pagesStartingWith<T>(first: T[], rest: AsyncIterator<T[]>): AsyncGenerator<T[]> {
    if (first.length > 0) yield first;
    for (let page = await rest.next(); !page.done; page = await rest.next()) {
        yield page.value;
    }
}

/** The pages of `pages`. Adds the id of each command item to `commandIds`. */
async function* withCommandIds(
    pages: AsyncIterable<ThreadItem[]>,
    commandIds: Set<string>,
): AsyncGenerator<ThreadItem[]> {
    for await (const items of pages) {
        for (const item of items) {
            if (item.type === "commandExecution") commandIds.add(item.id);
        }
        yield items;
    }
}

function mergeHistoryUpdates(
    responseItemFallbackUpdates: UpdateSessionEvent[],
    threadUpdates: UpdateSessionEvent[],
): UpdateSessionEvent[] {
    const merged: UpdateSessionEvent[] = [];
    const seen = new Set<string>();
    let fallbackIndex = 0;

    const pushUpdate = (update: UpdateSessionEvent) => {
        const key = historyUpdateKey(update);
        if (key && seen.has(key)) {
            return;
        }
        if (key) {
            seen.add(key);
        }
        merged.push(update);
    };

    const flushFallbackBeforeMatchingDuplicate = (targetUpdate: UpdateSessionEvent): void => {
        const targetKey = historyUpdateKey(targetUpdate);
        const targetContentKey = historyUpdateContentKey(targetUpdate);
        if (!targetKey && !targetContentKey) {
            return;
        }

        const matchIndex = responseItemFallbackUpdates.findIndex((update, index) => (
            index >= fallbackIndex
            && (
                (targetKey !== null && historyUpdateKey(update) === targetKey)
                || (targetContentKey !== null && historyUpdateContentKey(update) === targetContentKey)
            )
        ));
        if (matchIndex === -1) {
            return;
        }

        while (fallbackIndex < matchIndex) {
            pushUpdate(responseItemFallbackUpdates[fallbackIndex]!);
            fallbackIndex += 1;
        }
        fallbackIndex += 1;
    };

    for (const update of threadUpdates) {
        flushFallbackBeforeMatchingDuplicate(update);
        pushUpdate(update);
    }

    while (fallbackIndex < responseItemFallbackUpdates.length) {
        pushUpdate(responseItemFallbackUpdates[fallbackIndex]!);
        fallbackIndex += 1;
    }

    return merged;
}

function historyUpdateKey(update: UpdateSessionEvent): string | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return `${update.sessionUpdate}:${update.messageId ?? ""}:${JSON.stringify(update.content)}`;
        case "tool_call":
            return `tool_call:${update.toolCallId}:start`;
        case "tool_call_update":
            return `tool_call:${update.toolCallId}:update`;
        default:
            return null;
    }
}

function historyUpdateContentKey(update: UpdateSessionEvent): string | null {
    switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return `${update.sessionUpdate}:${JSON.stringify(update.content)}`;
        default:
            return historyUpdateKey(update);
    }
}
