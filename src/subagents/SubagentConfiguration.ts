import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type {ReasoningEffort} from "../app-server";
import {createReasoningEffortConfigOption, createSubagentModelConfigOption} from "../ModelConfigOption";
import type {SubagentModels} from "./CodexSubagentEventRouter";

export type ObservedSubagentConfiguration = {model: string | null; effort: ReasoningEffort | null; cwd?: string};

// Activity reports the resolved spawn model; settings report later changes.
export const CONFIGURATION_SOURCE_RANK = {threadStarted: 0, activity: 1, settings: 2} as const;
export type ConfigurationSource = keyof typeof CONFIGURATION_SOURCE_RANK;

export type ChildConfiguration = {
    model?: {model: string; source: ConfigurationSource};
    effort?: {value: ReasoningEffort | null; source: ConfigurationSource};
};

export function mergeSubagentConfiguration(
    previous: ChildConfiguration | undefined,
    observed: ObservedSubagentConfiguration,
    source: ConfigurationSource,
): ChildConfiguration {
    const rank = CONFIGURATION_SOURCE_RANK[source];
    let model = previous?.model;
    let effort = previous?.effort;
    if (observed.model && (!model || rank >= CONFIGURATION_SOURCE_RANK[model.source])) {
        model = {model: observed.model, source};
    }
    const changedModel = model?.model !== previous?.model?.model;
    const matchesModel = !observed.model || observed.model === model?.model;
    // A model change clears the previous effort; an explicit null also clears it.
    if (changedModel || (matchesModel && observed.effort !== undefined
        && (!effort || rank >= CONFIGURATION_SOURCE_RANK[effort.source]))) {
        effort = {value: observed.effort ?? null, source};
    }
    return {...(model ? {model} : {}), ...(effort ? {effort} : {})};
}

/** Complete reported snapshots contain only observed child values and singleton choices. */
export function subagentConfigurationOptions(
    models: SubagentModels | null, configuration: ObservedSubagentConfiguration,
): SessionConfigOption[] {
    if (!models) return [];
    const options: SessionConfigOption[] = [];
    if (configuration.model) {
        options.push(createSubagentModelConfigOption(models.availableModels, models.currentModel, configuration.model));
    }
    if (configuration.effort != null) {
        const model = models.availableModels.find(model => model.id === configuration.model || model.model === configuration.model);
        const effort = model?.supportedReasoningEfforts.find(option => option.reasoningEffort === configuration.effort)
            ?? {reasoningEffort: configuration.effort, description: "Current reasoning effort"};
        options.push(createReasoningEffortConfigOption([effort], configuration.effort));
    }
    return options;
}
