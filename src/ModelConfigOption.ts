import {RequestError} from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {LodySessionConfig} from "acp-extension-core";
import type {SessionConfigOption} from "@agentclientprotocol/sdk";
import type {ReasoningEffort} from "./app-server";
import type {Model, ReasoningEffortOption} from "./app-server/v2";
import {AIR_RECOMMENDED_CONFIG_VALUE_KEY, withAirMeta} from "./AirExtension";

export const MODEL_CONFIG_ID = "model";
export const REASONING_EFFORT_CONFIG_ID = "reasoning_effort";

/**
 * Turn Codex's GPT display ids into compact picker labels without coupling the
 * adapter to a particular model catalog. Custom/provider model names remain
 * untouched because their punctuation may be meaningful.
 */
export function formatModelDisplayName(displayName: string): string {
    if (!/^gpt-/i.test(displayName)) return displayName;
    return displayName
        .replace(/^gpt-/i, "")
        .split(/[-/]+/)
        .filter(Boolean)
        .map(capitalize)
        .join(" ");
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Display names for known efforts; naive capitalization would render "xhigh" as "Xhigh". */
const REASONING_EFFORT_DISPLAY_NAMES: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra",
};

function reasoningEffortDisplayName(effort: string): string {
    return REASONING_EFFORT_DISPLAY_NAMES[effort] ?? capitalize(effort);
}

export function findSupportedEffort(
    options: ReadonlyArray<ReasoningEffortOption>,
    effort: string | undefined,
): ReasoningEffort | undefined {
    if (!effort) return undefined;
    return options.find(o => o.reasoningEffort === effort)?.reasoningEffort;
}

export function createModelConfigOption(
    availableModels: Array<Model>,
    currentBaseModelId: string,
    recommendedModelId?: string,
): SessionConfigOption {
    const options: Array<{ value: string; name: string; description: string | null }> = availableModels.map(model => ({
        value: model.id,
        name: formatModelDisplayName(model.displayName),
        description: model.description,
    }));
    if (!availableModels.some(model => model.id === currentBaseModelId)) {
        options.unshift({
            value: currentBaseModelId,
            name: formatModelDisplayName(currentBaseModelId),
            description: null,
        });
    }

    const recommendation = recommendedModelId && options.some(option => option.value === recommendedModelId)
        ? recommendedModelId
        : undefined;
    return {
        id: MODEL_CONFIG_ID,
        name: "Model",
        description: "Model Codex uses for the session",
        category: "model",
        type: "select",
        currentValue: currentBaseModelId,
        options,
        ...(recommendation
            ? {_meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_KEY, recommendation)}
            : {}),
    };
}

export function createReasoningEffortConfigOption(
    supportedReasoningEfforts: Array<ReasoningEffortOption>,
    currentEffort: string,
    recommendedEffort?: string,
): SessionConfigOption {
    const recommendation = findSupportedEffort(supportedReasoningEfforts, recommendedEffort);
    return {
        id: REASONING_EFFORT_CONFIG_ID,
        name: "Reasoning effort",
        description: "How much reasoning effort the model should use",
        category: "thought_level",
        type: "select",
        currentValue: currentEffort,
        options: supportedReasoningEfforts.map(option => ({
            value: option.reasoningEffort,
            name: reasoningEffortDisplayName(option.reasoningEffort),
            description: option.description,
        })),
        ...(recommendation
            ? {_meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_KEY, recommendation)}
            : {}),
    };
}


const startupConfigSchema: z.ZodType<LodySessionConfig> = z.object({
    version: z.literal(1),
    modelId: z.string().min(1).optional(),
    configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

/** Translate the driving turn before Codex restores a thread or checks its recorded model. */
export function readStartupModelConfig(meta: unknown): {model?: string; model_reasoning_effort?: string} {
    if (typeof meta !== "object" || meta === null) return {};
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return {};
    const raw = (lody as Record<string, unknown>)["sessionConfig"];
    if (raw === undefined) return {};
    const parsed = startupConfigSchema.safeParse(raw);
    if (!parsed.success) throw RequestError.invalidParams(undefined, "Invalid sessionConfig version 1");
    const {modelId, configOptionValues} = parsed.data;
    const selectedModel = modelId ?? configOptionValues[MODEL_CONFIG_ID];
    const selectedEffort = configOptionValues[REASONING_EFFORT_CONFIG_ID];
    if (selectedModel !== undefined && (typeof selectedModel !== "string" || !selectedModel.trim())) {
        throw RequestError.invalidParams(undefined, "Invalid sessionConfig model");
    }
    const legacyModel = typeof selectedModel === "string" && selectedModel.includes("[")
        ? selectedModel.match(/^([^\[]+)\[([^\]]+)\]$/)
        : undefined;
    if (typeof selectedModel === "string" && selectedModel.includes("[") && !legacyModel) {
        throw RequestError.invalidParams(undefined, "Invalid sessionConfig model");
    }
    const effort = selectedEffort ?? legacyModel?.[2];
    if (effort !== undefined && (typeof effort !== "string" || !effort.trim())) {
        throw RequestError.invalidParams(undefined, "Invalid sessionConfig reasoning effort");
    }
    return {
        ...(selectedModel !== undefined ? {model: legacyModel?.[1] ?? selectedModel} : {}),
        ...(typeof effort === "string" ? {model_reasoning_effort: effort} : {}),
    };
}
