import type {ModelUsage, SessionUsageUpdate} from "acp-extension-core";
import type {ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown} from "./app-server/v2";

const keys = ["inputTokens", "outputTokens", "cacheReadInputTokens",
    "cacheCreationInputTokens", "reasoningOutputTokens"] as const;
const empty = (): ModelUsage => ({inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 0});

function normalize(total: TokenUsageBreakdown): ModelUsage {
    return {
        inputTokens: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens),
        outputTokens: Math.max(0, total.outputTokens - total.reasoningOutputTokens),
        cacheReadInputTokens: total.cachedInputTokens,
        cacheCreationInputTokens: total.cacheWriteInputTokens,
        reasoningOutputTokens: total.reasoningOutputTokens,
    };
}

export type CodexTurnUsageUpdate = SessionUsageUpdate & {
    // Notification-local accounting scope, not persisted session metadata.
    // `codex.usageTurnId` is the legacy spelling kept for older Lody clients.
    _meta: {lody: {usageScopeId: string}; codex: {usageTurnId: string}};
};

/** One native turn is one accounting lifetime. No disk state or historical model ledger. */
export class CodexTurnUsage {
    private previous: ModelUsage | undefined;
    private turn: {id: string; model: string; usage: ModelUsage} | undefined;
    private requestedModel: string | undefined;

    constructor(fresh = false, snapshot?: TokenUsageBreakdown) {
        this.previous = snapshot ? normalize(snapshot) : fresh ? empty() : undefined;
    }

    prepare(model: string): void { this.requestedModel = model; }

    start(turnId: string, model: string): void {
        if (this.turn?.id === turnId) return;
        this.turn = {id: turnId, model: this.requestedModel ?? model, usage: empty()};
    }

    update(params: ThreadTokenUsageUpdatedNotification): CodexTurnUsageUpdate | undefined {
        const next = normalize(params.tokenUsage.total);
        const turn = this.turn;
        if (!turn) {
            // A native resume snapshot is history, not new work.
            this.previous = next;
            return undefined;
        }
        if (params.turnId !== turn.id) return undefined;
        // Missing resume snapshots anchor conservatively: last can be old usage
        // re-emitted by a rate-limit update, not a new response.
        if (!this.previous) { this.previous = next; return undefined; }
        const delta = empty();
        for (const key of keys) delta[key] = Math.max(0, (next[key] ?? 0) - (this.previous[key] ?? 0));
        this.previous = next;
        if (!keys.some(key => (delta[key] ?? 0) > 0)) return undefined;
        for (const key of keys) turn.usage[key] = (turn.usage[key] ?? 0) + (delta[key] ?? 0);
        return {
            sessionId: params.threadId,
            usage: {...turn.usage, ...(params.tokenUsage.modelContextWindow !== null
                && {contextWindow: params.tokenUsage.modelContextWindow})},
            modelUsage: {[turn.model]: {...turn.usage}},
            _meta: {lody: {usageScopeId: turn.id}, codex: {usageTurnId: turn.id}},
        };
    }
}
