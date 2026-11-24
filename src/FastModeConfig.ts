import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {Model} from "./app-server/v2";

export type CodexSpeedTier = "fast" | "ultrafast";

export const FAST_MODE_CONFIG_ID = "fast-mode";
export const FAST_MODE_CATEGORY = "model_config";
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";
export const FAST_MODE_FAST: CodexSpeedTier = "fast";
export const FAST_MODE_ULTRAFAST: CodexSpeedTier = "ultrafast";

const FAST_MODE_DESCRIPTION = "1.5x speed, increased usage";
const ULTRAFAST_MODE_DESCRIPTION = "The fastest available responses for latency-sensitive work.";
const STANDARD_MODE_DESCRIPTION = "Default speed, normal usage";

const SPEED_TIER_ORDER: readonly CodexSpeedTier[] = [FAST_MODE_FAST, FAST_MODE_ULTRAFAST];

export type ModelSpeedTierOption = {
    tier: CodexSpeedTier;
    name: string;
    description: string;
};

export function parseSpeedTierFromServiceTier(serviceTier: string | null | undefined): CodexSpeedTier | null {
    // Codex returns the canonical "priority" tier even when configured with "fast".
    if (serviceTier === "fast" || serviceTier === "priority") {
        return FAST_MODE_FAST;
    }
    if (serviceTier === "ultrafast") {
        return FAST_MODE_ULTRAFAST;
    }
    return null;
}

export function modelSpeedTierOptions(model: Model | undefined): ModelSpeedTierOption[] {
    if (!model) {
        return [];
    }
    const byTier = new Map<CodexSpeedTier, ModelSpeedTierOption>();
    for (const entry of model.serviceTiers ?? []) {
        const tier = parseSpeedTierFromServiceTier(entry.id);
        if (!tier || byTier.has(tier)) continue;
        byTier.set(tier, {
            tier,
            name: entry.name?.trim() || (tier === FAST_MODE_ULTRAFAST ? "Ultrafast" : "Fast"),
            description:
                entry.description?.trim() ||
                (tier === FAST_MODE_ULTRAFAST ? ULTRAFAST_MODE_DESCRIPTION : FAST_MODE_DESCRIPTION),
        });
    }
    for (const rawTier of model.additionalSpeedTiers ?? []) {
        const tier = parseSpeedTierFromServiceTier(rawTier);
        if (!tier || byTier.has(tier)) continue;
        byTier.set(tier, {
            tier,
            name: tier === FAST_MODE_ULTRAFAST ? "Ultrafast" : "Fast",
            description: tier === FAST_MODE_ULTRAFAST ? ULTRAFAST_MODE_DESCRIPTION : FAST_MODE_DESCRIPTION,
        });
    }
    return SPEED_TIER_ORDER
        .map(tier => byTier.get(tier))
        .filter((entry): entry is ModelSpeedTierOption => entry !== undefined);
}

export function modelSpeedTiers(model: Model | undefined): CodexSpeedTier[] {
    return modelSpeedTierOptions(model).map(entry => entry.tier);
}

export function modelSupportsFast(model: Model | undefined): boolean {
    return modelSpeedTiers(model).includes(FAST_MODE_FAST);
}

export function serviceTierEnablesFast(serviceTier: string | null | undefined): boolean {
    return parseSpeedTierFromServiceTier(serviceTier) === FAST_MODE_FAST;
}

export function resolveSpeedServiceTier(
    selectedTier: CodexSpeedTier | null,
    supportedTiers: readonly CodexSpeedTier[],
): CodexSpeedTier | null {
    return selectedTier && supportedTiers.includes(selectedTier) ? selectedTier : null;
}

export function resolveFastServiceTier(fastModeEnabled: boolean, currentModelSupportsFast: boolean): CodexSpeedTier | null {
    return resolveSpeedServiceTier(
        fastModeEnabled ? FAST_MODE_FAST : null,
        currentModelSupportsFast ? [FAST_MODE_FAST] : [],
    );
}

export function parseSpeedTierConfigValue(
    value: string | boolean,
    supportedTiers: readonly CodexSpeedTier[],
): { valid: true; tier: CodexSpeedTier | null } | { valid: false } {
    if (typeof value === "boolean") {
        return {valid: true, tier: value ? FAST_MODE_FAST : null};
    }
    if (value === FAST_MODE_OFF || value === "standard" || value === "default") {
        return {valid: true, tier: null};
    }
    if (value === FAST_MODE_ON || value === FAST_MODE_FAST || value === "priority") {
        return {valid: true, tier: FAST_MODE_FAST};
    }
    if (value === FAST_MODE_ULTRAFAST && supportedTiers.includes(FAST_MODE_ULTRAFAST)) {
        return {valid: true, tier: FAST_MODE_ULTRAFAST};
    }
    return {valid: false};
}

export function clientSupportsBooleanConfigOptions(clientCapabilities?: acp.ClientCapabilities | null): boolean {
    return clientCapabilities?.session?.configOptions?.boolean != null;
}

export function createFastModeConfigOption(fastModeEnabled: boolean, useBooleanConfigOption = false): SessionConfigOption {
    if (useBooleanConfigOption) {
        return {
            id: FAST_MODE_CONFIG_ID,
            name: "Fast mode",
            description: FAST_MODE_DESCRIPTION,
            category: FAST_MODE_CATEGORY,
            type: "boolean",
            currentValue: fastModeEnabled,
        };
    }

    return {
        id: FAST_MODE_CONFIG_ID,
        name: "Fast mode",
        description: FAST_MODE_DESCRIPTION,
        category: FAST_MODE_CATEGORY,
        type: "select",
        currentValue: fastModeEnabled ? FAST_MODE_ON : FAST_MODE_OFF,
        options: [
            {
                value: FAST_MODE_OFF,
                name: "Off",
                description: STANDARD_MODE_DESCRIPTION,
            },
            {
                value: FAST_MODE_ON,
                name: "On",
                description: FAST_MODE_DESCRIPTION,
            },
        ],
    };
}

export function createSpeedConfigOption(
    selectedTier: CodexSpeedTier | null,
    tierOptions: readonly ModelSpeedTierOption[],
    useBooleanConfigOption = false,
): SessionConfigOption | null {
    if (tierOptions.length === 0) {
        return null;
    }
    const hasUltrafast = tierOptions.some(entry => entry.tier === FAST_MODE_ULTRAFAST);
    if (!hasUltrafast) {
        return createFastModeConfigOption(selectedTier === FAST_MODE_FAST, useBooleanConfigOption);
    }

    const currentValue =
        selectedTier && tierOptions.some(entry => entry.tier === selectedTier)
            ? selectedTier
            : FAST_MODE_OFF;

    return {
        id: FAST_MODE_CONFIG_ID,
        name: "Speed",
        description: "Response speed tier for the session",
        category: FAST_MODE_CATEGORY,
        type: "select",
        currentValue,
        options: [
            {
                value: FAST_MODE_OFF,
                name: "Standard",
                description: STANDARD_MODE_DESCRIPTION,
            },
            ...tierOptions.map(entry => ({
                value: entry.tier,
                name: entry.name,
                description: entry.description,
            })),
        ],
    };
}
