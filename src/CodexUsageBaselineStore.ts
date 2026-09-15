import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelUsage } from "acp-extension-core";

export type PersistedCodexUsageAccounting = {
    version: 1;
    /** Cumulative model attribution for this Codex thread. */
    modelUsage: Record<string, ModelUsage>;
    /** Fork source history that must never be counted as this thread's usage. */
    excludedTotal?: ModelUsage;
    /** A fork has not yet observed the first thread total to compute excludedTotal. */
    pendingForkExclusion?: boolean;
};

export interface CodexUsageStore {
    load(): PersistedCodexUsageAccounting | null;
    save(state: PersistedCodexUsageAccounting): void;
}

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

const validThreadId = (threadId: string): boolean => /^[A-Za-z0-9_-]+$/.test(threadId);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readUsage = (value: unknown): ModelUsage | null => {
    if (!isRecord(value)) return null;
    const usage = empty();
    for (const key of counters) {
        const raw = value[key];
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
        usage[key] = raw;
    }
    return usage;
};

const readModelUsage = (value: unknown): Record<string, ModelUsage> | null => {
    if (!isRecord(value)) return null;
    const result: Record<string, ModelUsage> = {};
    for (const [model, raw] of Object.entries(value)) {
        const usage = readUsage(raw);
        if (usage) result[model] = usage;
    }
    return result;
};

const mergeUsage = (left: ModelUsage, right: ModelUsage): ModelUsage => {
    const merged = empty();
    for (const key of counters) merged[key] = Math.max(left[key] ?? 0, right[key] ?? 0);
    return merged;
};

const mergeModelUsage = (
    left: Record<string, ModelUsage>,
    right: Record<string, ModelUsage>
): Record<string, ModelUsage> => {
    const merged: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(left)) merged[model] = { ...usage };
    for (const [model, usage] of Object.entries(right)) {
        const previous = merged[model];
        merged[model] = previous ? mergeUsage(previous, usage) : { ...usage };
    }
    return merged;
};

const parsePersisted = (value: unknown): PersistedCodexUsageAccounting | null => {
    if (!isRecord(value) || value.version !== 1) return null;
    const modelUsage = readModelUsage(value.modelUsage);
    if (!modelUsage) return null;
    const excludedTotal =
        value.excludedTotal === undefined
            ? undefined
            : (readUsage(value.excludedTotal) ?? undefined);
    return {
        version: 1,
        modelUsage,
        excludedTotal,
        pendingForkExclusion:
            value.pendingForkExclusion === true
                ? true
                : value.pendingForkExclusion === false
                  ? false
                  : undefined,
    };
};

class FileCodexUsageStore implements CodexUsageStore {
    constructor(private readonly filePath: string) {}

    load(): PersistedCodexUsageAccounting | null {
        try {
            return parsePersisted(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
        } catch {
            return null;
        }
    }

    save(state: PersistedCodexUsageAccounting): void {
        const merged = this.mergeWithExisting(state);
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(merged), "utf8");
        try {
            fs.renameSync(temporaryPath, this.filePath);
        } catch {
            // Windows cannot replace an existing destination in one rename.
            fs.rmSync(this.filePath, { force: true });
            fs.renameSync(temporaryPath, this.filePath);
        }
    }

    private mergeWithExisting(state: PersistedCodexUsageAccounting): PersistedCodexUsageAccounting {
        const existing = this.load();
        if (!existing) return state;
        const modelUsage = mergeModelUsage(existing.modelUsage, state.modelUsage);
        const excludedTotal =
            existing.excludedTotal && state.excludedTotal
                ? mergeUsage(existing.excludedTotal, state.excludedTotal)
                : (state.excludedTotal ?? existing.excludedTotal);
        return {
            version: 1,
            modelUsage,
            excludedTotal,
            pendingForkExclusion: state.pendingForkExclusion ?? existing.pendingForkExclusion,
        };
    }
}

export const createCodexUsageStore = (
    codexHome: string | null | undefined,
    threadId: string
): CodexUsageStore | null => {
    if (!codexHome || !validThreadId(threadId)) return null;
    return new FileCodexUsageStore(
        path.join(codexHome, "lody-usage-baselines", `${threadId}.json`)
    );
};
