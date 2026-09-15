import type { ModelUsage } from "acp-extension-core";
import type { ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown } from "./app-server/v2";

// thread/tokenUsage/updated has no model attribution. Never label a thread-wide
// counter with the selected model: switching models would count history twice.
export const CODEX_UNATTRIBUTED_MODEL = "codex:unattributed";
const counters = ["inputTokens", "outputTokens", "cacheReadInputTokens",
    "cacheCreationInputTokens", "reasoningOutputTokens"] as const;
const empty = (): ModelUsage => ({inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 0});

export function normalizeCodexUsage(raw: TokenUsageBreakdown): ModelUsage {
    return {
        inputTokens: Math.max(0, raw.inputTokens - raw.cachedInputTokens - raw.cacheWriteInputTokens),
        outputTokens: Math.max(0, raw.outputTokens - raw.reasoningOutputTokens),
        cacheReadInputTokens: raw.cachedInputTokens,
        cacheCreationInputTokens: raw.cacheWriteInputTokens,
        reasoningOutputTokens: raw.reasoningOutputTokens,
    };
}

/** One instance per active SessionState, never per prompt handler. Context-window
 * fill notifications reset the native breakdown, not the accounting total. This
 * process-local baseline is not a claim of durable resume continuity. */
export class CodexUsageAccounting {
    private offset = empty();
    private total = empty();
    private atReset = false;

    update(sessionId: string, params: ThreadTokenUsageUpdatedNotification) {
        const {total: raw, modelContextWindow} = params.tokenUsage;
        // rust-v0.153.4 TokenUsageInfo::fill_to_context_window emits this explicit
        // sentinel. An ordinary zero-token or cache-only update is not compaction.
        const reset = modelContextWindow !== null && modelContextWindow > 0 &&
            raw.totalTokens === modelContextWindow && raw.inputTokens === 0 &&
            raw.outputTokens === 0 && raw.cachedInputTokens === 0 &&
            raw.cacheWriteInputTokens === 0 && raw.reasoningOutputTokens === 0;
        if (reset && !this.atReset) this.offset = {...this.total};
        this.atReset = reset;
        const normalized = normalizeCodexUsage(raw);
        const next = empty();
        const difference = empty();
        for (const key of counters) {
            // A stale notification cannot retract already observed accounting.
            next[key] = Math.max(this.total[key] ?? 0, (this.offset[key] ?? 0) + (normalized[key] ?? 0));
            difference[key] = (next[key] ?? 0) - (this.total[key] ?? 0);
        }
        this.total = next;
        // Keep Codex's legacy top-level cumulative scope. In particular, never
        // forward a reset sentinel as a new zero bill to an older consumer.
        const usage = {...next};
        if (modelContextWindow !== null) usage.contextWindow = modelContextWindow;
        return {
            sessionId,
            usage,
            modelUsage: {[CODEX_UNATTRIBUTED_MODEL]: {...next}},
            delta: {usage: {...difference}, modelUsage: {[CODEX_UNATTRIBUTED_MODEL]: {...difference}}},
        };
    }
}
