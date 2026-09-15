import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelUsage } from "acp-extension-core";

export type PersistedCodexUsageAccounting = {
    version: 1;
    /** Cumulative model attribution for this Codex thread. */
    modelUsage: Record<string, ModelUsage>;
    /**
     * History before this accounting lifetime: fork source history or the
     * captured native baseline of a resumed thread without a sidecar.
     */
    excludedTotal?: ModelUsage;
    /** A fork has not yet observed the first thread total to compute excludedTotal. */
    pendingForkExclusion?: boolean;
    /** Native reset state is one cursor; never merge its fields independently. */
    cursor?: {
        offset: ModelUsage; threadTotal: ModelUsage; atReset: boolean;
        pendingRootResponses?: ModelUsage;
        subagentUsage?: ModelUsage;
    };
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
    if (!isRecord(value) || value['version'] !== 1) return null;
    const modelUsage = readModelUsage(value['modelUsage']);
    if (!modelUsage) return null;
    const excludedTotal =
        value['excludedTotal'] === undefined
            ? undefined
            : (readUsage(value['excludedTotal']) ?? undefined);
    let cursor: PersistedCodexUsageAccounting["cursor"];
    const rawCursor = value['cursor'];
    if (isRecord(rawCursor)) {
        const offset = readUsage(rawCursor['offset']);
        const threadTotal = readUsage(rawCursor['threadTotal']);
        if (offset && threadTotal && typeof rawCursor['atReset'] === "boolean") {
            cursor = {offset, threadTotal, atReset: rawCursor['atReset']};
            const pendingRootResponses = readUsage(rawCursor['pendingRootResponses']);
            const subagentUsage = readUsage(rawCursor['subagentUsage']);
            if (pendingRootResponses) cursor.pendingRootResponses = pendingRootResponses;
            if (subagentUsage) cursor.subagentUsage = subagentUsage;
        }
    }
    return {
        version: 1,
        modelUsage,
        ...(excludedTotal && {excludedTotal}),
        ...(cursor && {cursor}),
        ...(typeof value['pendingForkExclusion'] === 'boolean' && {
            pendingForkExclusion: value['pendingForkExclusion'],
        }),
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
        } catch (error) {
            // A failed replacement must preserve the last complete baseline.
            fs.rmSync(temporaryPath, { force: true });
            throw error;
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
        const pendingForkExclusion = state.pendingForkExclusion ?? existing.pendingForkExclusion;
        return {
            version: 1,
            modelUsage,
            ...(excludedTotal && {excludedTotal}),
            ...(pendingForkExclusion !== undefined && {pendingForkExclusion}),
            ...(state.cursor && {cursor: state.cursor}),
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
