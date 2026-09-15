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
    modelUsage: NonNullable<SessionUsageUpdate["modelUsage"]>;
};

export type CodexUsageAccountingOptions = {
    threadId?: string;
    codexHome?: string | null;
    /** True when this ACP session is a new Codex fork; exclude source history. */
    forkFromHistory?: boolean;
    /** Restored native snapshot captured before the first new turn. */
    usageBaseline?: ThreadTokenUsageUpdatedNotification;
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

    private offset = empty();
    private threadTotal = empty();
    private atReset = false;
    private pendingRootResponses = empty();
    private subagentUsage = empty();
    private modelContextWindow: number | null = null;

    private readonly threadModels = new Map<string, string>();
    private readonly turnModels = new Map<string, string>();
    private readonly compactingThreads = new Set<string>();
    private readonly reroutedTurns = new Set<string>();
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
            if (restored.cursor) {
                this.offset = cloneUsage(restored.cursor.offset);
                this.threadTotal = cloneUsage(restored.cursor.threadTotal);
                this.atReset = restored.cursor.atReset;
                this.pendingRootResponses = cloneUsage(restored.cursor.pendingRootResponses ?? empty());
                this.subagentUsage = cloneUsage(restored.cursor.subagentUsage ?? empty());
            }
        } else {
            this.modelUsage = {};
            this.excludedTotal = empty();
        }
        if (options.forkFromHistory || restored?.pendingForkExclusion) {
            // Fork replay precedes thread/started. Its captured total is source
            // history; never infer this from the first paid response's total.
            const baseline = options.usageBaseline
                ? normalizeCodexUsage(options.usageBaseline.tokenUsage.total)
                : empty();
            // The old pending format could already contain exact child usage.
            this.excludedTotal = restored?.pendingForkExclusion
                ? subtract(baseline, sumModelUsage(this.modelUsage))
                : baseline;
            this.threadTotal = cloneUsage(this.excludedTotal);
        }
        if (restored && !restored.cursor && options.usageBaseline) {
            // V1 before native cursors: anchor the retained cumulative ledger
            // to the replayed counter so post-upgrade increments are not lost.
            const retainedTotal = sumModelUsage(this.modelUsage);
            addInto(retainedTotal, this.excludedTotal);
            this.offset = subtract(retainedTotal, normalizeCodexUsage(options.usageBaseline.tokenUsage.total));
            this.threadTotal = retainedTotal;
        }
        if (options.usageBaseline) this.update(options.threadId ?? options.usageBaseline.threadId, options.usageBaseline);
        // Persist even an idle fork, before it can be closed and resumed.
        this.persist();
    }

    noteThreadModel(threadId: string, model: string | null | undefined): void {
        const normalized = model?.trim();
        if (normalized) this.threadModels.set(threadId, normalized);
    }

    noteTurnModel(turnId: string, model: string | null | undefined): void {
        const normalized = model?.trim();
        if (normalized) this.turnModels.set(turnId, normalized);
    }

    setCompacting(threadId: string, compacting: boolean): void {
        if (compacting) this.compactingThreads.add(threadId);
        else this.compactingThreads.delete(threadId);
    }

    noteReroutedModel(turnId: string, model: string): void {
        if (this.reroutedTurns.has(turnId)) return;
        this.noteTurnModel(turnId, model);
        this.reroutedTurns.add(turnId);
    }

    /** Exact usage from one upstream Responses API completion. */
    recordResponse(
        sessionId: string,
        params: RawResponseCompletedNotification
    ): CodexUsageUpdate | undefined {
        if (!this.rememberResponse(params.responseId)) return undefined;
        const model = this.resolveModel(params.threadId, params.turnId);
        // Native reports only the first mismatch in a turn. That evidence
        // describes this completion, not every later response in the turn.
        if (this.reroutedTurns.has(params.turnId)) {
            this.turnModels.set(params.turnId, CODEX_UNATTRIBUTED_MODEL);
        }
        if (!params.usage) return undefined;
        const normalized = normalizeCodexUsage(params.usage);
        if (isZero(normalized)) return undefined;
        const target = this.modelUsage[model] ?? empty();
        addInto(target, normalized);
        this.modelUsage[model] = target;
        if (params.threadId === sessionId) addInto(this.pendingRootResponses, normalized);
        else addInto(this.subagentUsage, normalized);
        this.persist();
        return this.buildUpdate(sessionId);
    }

    update(sessionId: string, params: ThreadTokenUsageUpdatedNotification): CodexUsageUpdate {
        // Child totals include inherited context and have independent reset
        // epochs. Only their exact responses belong in this session's ledger.
        if (params.threadId !== sessionId) return this.buildUpdate(sessionId);
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
        if (reset) {
            if (!this.atReset) this.offset = { ...this.threadTotal };
            // A crash can leave raw persisted while its native total was still
            // queued. A replayed reset must retain that already billed work.
            addInto(this.offset, this.pendingRootResponses);
        }
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
        this.pendingRootResponses = subtract(this.pendingRootResponses, subtract(next, this.threadTotal));
        this.threadTotal = next;
        if (modelContextWindow !== null) this.modelContextWindow = modelContextWindow;

        const accounted = subtract(this.threadTotal, this.excludedTotal);
        const rootAccounted = subtract(sumModelUsage(this.modelUsage), this.subagentUsage);
        const residual = subtract(accounted, rootAccounted);
        if (!isZero(residual)) {
            const target = this.modelUsage[CODEX_UNATTRIBUTED_MODEL] ?? empty();
            addInto(target, residual);
            this.modelUsage[CODEX_UNATTRIBUTED_MODEL] = target;
        }

        this.persist();
        return this.buildUpdate(sessionId);
    }

    private resolveModel(threadId: string, turnId: string): string {
        // Compaction can run on the previous model or a native fallback while
        // retaining this turn's id. The event carries no producing model.
        if (this.compactingThreads.has(threadId)) return CODEX_UNATTRIBUTED_MODEL;
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
            cursor: {
                offset: cloneUsage(this.offset),
                threadTotal: cloneUsage(this.threadTotal),
                atReset: this.atReset,
                pendingRootResponses: cloneUsage(this.pendingRootResponses),
                subagentUsage: cloneUsage(this.subagentUsage),
            },
        };
        if (!isZero(this.excludedTotal)) state.excludedTotal = cloneUsage(this.excludedTotal);
        state.pendingForkExclusion = false;
        try {
            this.store.save(state);
        } catch (error) {
            logger.error("Failed to persist Codex usage baseline", error);
        }
    }
}
