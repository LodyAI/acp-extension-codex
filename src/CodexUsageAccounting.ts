import type { ModelUsage, SessionUsageUpdate } from "acp-extension-core";
import type {
    RawResponseCompletedNotification,
    ThreadTokenUsageUpdatedNotification,
    TokenUsageBreakdown,
} from "./app-server/v2";
import { logger } from "./Logger";
import {
    createCodexUsageStore,
    type CodexUsageStore,
    type PersistedCodexUsageAccounting,
} from "./CodexUsageBaselineStore";

// thread/tokenUsage/updated has no model attribution. Never label a thread-wide
// counter with the selected model: switching models would count history twice.
export const CODEX_UNATTRIBUTED_MODEL = "codex:unattributed";

const counters = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
] as const;

const empty = (): ModelUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
});

export function normalizeCodexUsage(raw: TokenUsageBreakdown): ModelUsage {
    return {
        inputTokens: Math.max(
            0,
            raw.inputTokens - raw.cachedInputTokens - raw.cacheWriteInputTokens
        ),
        outputTokens: Math.max(0, raw.outputTokens - raw.reasoningOutputTokens),
        cacheReadInputTokens: raw.cachedInputTokens,
        cacheCreationInputTokens: raw.cacheWriteInputTokens,
        reasoningOutputTokens: raw.reasoningOutputTokens,
    };
}

const cloneUsage = (usage: ModelUsage): ModelUsage => ({ ...usage });

const cloneModelUsage = (modelUsage: Record<string, ModelUsage>): Record<string, ModelUsage> => {
    const cloned: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(modelUsage)) cloned[model] = cloneUsage(usage);
    return cloned;
};

const addInto = (target: ModelUsage, source: ModelUsage): void => {
    for (const key of counters) target[key] = (target[key] ?? 0) + (source[key] ?? 0);
};

const subtract = (left: ModelUsage, right: ModelUsage): ModelUsage => {
    const result = empty();
    for (const key of counters) result[key] = Math.max(0, (left[key] ?? 0) - (right[key] ?? 0));
    return result;
};

const sumModelUsage = (modelUsage: Record<string, ModelUsage>): ModelUsage => {
    const total = empty();
    for (const usage of Object.values(modelUsage)) addInto(total, usage);
    return total;
};

const hasCounters = (usage: ModelUsage): boolean => counters.some((key) => (usage[key] ?? 0) !== 0);

const differenceFrom = (
    current: Record<string, ModelUsage>,
    previous: Record<string, ModelUsage>
): { usage: ModelUsage; modelUsage: Record<string, ModelUsage> } | undefined => {
    const delta: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(current)) {
        const before = previous[model] ?? empty();
        const row = empty();
        let changed = false;
        for (const key of counters) {
            const difference = (usage[key] ?? 0) - (before[key] ?? 0);
            if (difference > 0) {
                row[key] = difference;
                changed = true;
            }
        }
        if (changed) delta[model] = row;
    }
    const usage = sumModelUsage(delta);
    return hasCounters(usage) ? { usage, modelUsage: delta } : undefined;
};

const isZero = (usage: ModelUsage): boolean => !hasCounters(usage);

export type CodexUsageUpdate = SessionUsageUpdate & {
    delta: NonNullable<SessionUsageUpdate["delta"]>;
};

export type CodexUsageAccountingOptions = {
    threadId?: string;
    codexHome?: string | null;
    /** True when this ACP session is a new Codex fork; exclude source history. */
    forkFromHistory?: boolean;
};

/** One instance per active SessionState, never per prompt handler.
 *
 * `thread/tokenUsage/updated` remains the cumulative thread total. Exact
 * per-response `rawResponse/completed` events are attributed to the model that
 * produced them. Any residual thread total that was not covered by a
 * per-response event (older runtimes, replay, unknown model) stays in
 * `codex:unattributed` so the total never drops and never fabricates a model.
 *
 * A small sidecar under $CODEX_HOME restores the cumulative model ledger after
 * process restarts. It is bookkeeping, not a durable delivery ledger: failed
 * notifications are retried by the CLI from its own cumulative snapshot. */
export class CodexUsageAccounting {
    private readonly store: CodexUsageStore | null;
    private modelUsage: Record<string, ModelUsage>;
    private excludedTotal: ModelUsage;
    private seedForkExclusion: boolean;

    private offset = empty();
    private threadTotal = empty();
    private atReset = false;
    private modelContextWindow: number | null = null;

    private readonly threadModels = new Map<string, string>();
    private readonly turnModels = new Map<string, string>();
    private readonly responseIds = new Set<string>();
    private readonly responseIdOrder: string[] = [];
    private lastEmittedModelUsage: Record<string, ModelUsage> | null = null;

    constructor(options: CodexUsageAccountingOptions = {}) {
        this.store = createCodexUsageStore(options.codexHome, options.threadId ?? "");
        const restored = this.store?.load() ?? null;
        if (restored) {
            this.modelUsage = cloneModelUsage(restored.modelUsage);
            this.excludedTotal = restored.excludedTotal
                ? cloneUsage(restored.excludedTotal)
                : empty();
            this.seedForkExclusion = restored.pendingForkExclusion === true;
        } else {
            this.modelUsage = {};
            this.excludedTotal = empty();
            this.seedForkExclusion = options.forkFromHistory === true;
        }
    }

    noteThreadModel(threadId: string, model: string | null | undefined): void {
        const normalized = model?.trim();
        if (normalized) this.threadModels.set(threadId, normalized);
    }

    noteTurnModel(turnId: string, model: string | null | undefined): void {
        const normalized = model?.trim();
        if (normalized) this.turnModels.set(turnId, normalized);
    }

    /** Exact usage from one upstream Responses API completion. */
    recordResponse(
        sessionId: string,
        params: RawResponseCompletedNotification
    ): CodexUsageUpdate | undefined {
        if (!params.usage) return undefined;
        const normalized = normalizeCodexUsage(params.usage);
        if (isZero(normalized)) return undefined;
        if (!this.rememberResponse(params.responseId)) return undefined;
        const model = this.resolveModel(params.threadId, params.turnId);
        const target = this.modelUsage[model] ?? empty();
        addInto(target, normalized);
        this.modelUsage[model] = target;
        this.persist();
        return this.buildUpdate(sessionId);
    }

    update(sessionId: string, params: ThreadTokenUsageUpdatedNotification): CodexUsageUpdate {
        const { total: raw, modelContextWindow } = params.tokenUsage;
        // rust-v0.153.4 TokenUsageInfo::fill_to_context_window emits this explicit
        // sentinel. An ordinary zero-token or cache-only update is not compaction.
        const reset =
            modelContextWindow !== null &&
            modelContextWindow > 0 &&
            raw.totalTokens === modelContextWindow &&
            raw.inputTokens === 0 &&
            raw.outputTokens === 0 &&
            raw.cachedInputTokens === 0 &&
            raw.cacheWriteInputTokens === 0 &&
            raw.reasoningOutputTokens === 0;
        if (reset && !this.atReset) this.offset = { ...this.threadTotal };
        this.atReset = reset;

        const normalized = normalizeCodexUsage(raw);
        const next = empty();
        for (const key of counters) {
            // A stale notification cannot retract already observed accounting.
            next[key] = Math.max(
                this.threadTotal[key] ?? 0,
                (this.offset[key] ?? 0) + (normalized[key] ?? 0)
            );
        }
        this.threadTotal = next;
        if (modelContextWindow !== null) this.modelContextWindow = modelContextWindow;

        if (this.seedForkExclusion) {
            // A fork reports source history in its thread total. Treat the first
            // total outside already observed post-fork responses as excluded.
            this.excludedTotal = subtract(this.threadTotal, sumModelUsage(this.modelUsage));
            this.seedForkExclusion = false;
        }

        const accounted = subtract(this.threadTotal, this.excludedTotal);
        const residual = subtract(accounted, sumModelUsage(this.modelUsage));
        if (!isZero(residual)) {
            const target = this.modelUsage[CODEX_UNATTRIBUTED_MODEL] ?? empty();
            addInto(target, residual);
            this.modelUsage[CODEX_UNATTRIBUTED_MODEL] = target;
        }

        this.persist();
        return this.buildUpdate(sessionId);
    }

    private resolveModel(threadId: string, turnId: string): string {
        return (
            this.turnModels.get(turnId) ??
            this.threadModels.get(threadId) ??
            CODEX_UNATTRIBUTED_MODEL
        );
    }

    private rememberResponse(responseId: string): boolean {
        if (this.responseIds.has(responseId)) return false;
        this.responseIds.add(responseId);
        this.responseIdOrder.push(responseId);
        if (this.responseIdOrder.length > 4096) {
            const expired = this.responseIdOrder.shift();
            if (expired) this.responseIds.delete(expired);
        }
        return true;
    }

    private buildUpdate(sessionId: string): CodexUsageUpdate {
        const modelUsage = cloneModelUsage(this.modelUsage);
        const usage = sumModelUsage(modelUsage);
        if (this.modelContextWindow !== null) usage.contextWindow = this.modelContextWindow;
        const delta = differenceFrom(modelUsage, this.lastEmittedModelUsage ?? {});
        const update: CodexUsageUpdate = {
            sessionId,
            usage,
            modelUsage,
            delta: delta ?? { usage: empty(), modelUsage: {} },
        };
        this.lastEmittedModelUsage = cloneModelUsage(modelUsage);
        return update;
    }

    private persist(): void {
        if (!this.store) return;
        const state: PersistedCodexUsageAccounting = {
            version: 1,
            modelUsage: cloneModelUsage(this.modelUsage),
        };
        if (!isZero(this.excludedTotal)) state.excludedTotal = cloneUsage(this.excludedTotal);
        state.pendingForkExclusion = this.seedForkExclusion;
        try {
            this.store.save(state);
        } catch (error) {
            logger.error("Failed to persist Codex usage baseline", error);
        }
    }
}
