import type {SessionUsageUpdate} from "acp-extension-core";
import type {ThreadTokenUsageUpdatedNotification} from "./app-server/v2";

// Native totals have no model dimension. Never price them as the selected model.
export const CODEX_UNATTRIBUTED_MODEL = "codex:unattributed";

/** Project the native snapshot; do not accumulate, exclude history, or invent a delta. */
export function toCodexUsageUpdate(params: ThreadTokenUsageUpdatedNotification): SessionUsageUpdate {
    const {total, modelContextWindow} = params.tokenUsage;
    const usage = {
        inputTokens: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens),
        outputTokens: Math.max(0, total.outputTokens - total.reasoningOutputTokens),
        cacheReadInputTokens: total.cachedInputTokens,
        cacheCreationInputTokens: total.cacheWriteInputTokens,
        reasoningOutputTokens: total.reasoningOutputTokens,
    };
    return {
        sessionId: params.threadId,
        usage: {...usage, ...(modelContextWindow !== null && {contextWindow: modelContextWindow})},
        modelUsage: {[CODEX_UNATTRIBUTED_MODEL]: {...usage}},
    };
}
