import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    setupPromptTestSession,
} from "../acp-test-utils";
import {
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_FAST,
    FAST_MODE_OFF,
    FAST_MODE_ON,
    FAST_MODE_ULTRAFAST,
} from "../../FastModeConfig";
import {MODEL_CONFIG_ID} from "../../ModelConfigOption";

describe("Fast mode session config", () => {
    const booleanConfigCapabilities: acp.ClientCapabilities = {
        session: {
            configOptions: {
                boolean: {},
            },
        },
    };

    async function createSession(
        currentServiceTier: string | null = null,
        clientInfo: acp.Implementation | null = null,
        clientCapabilities?: acp.ClientCapabilities,
    ) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const fastModel = createTestModel({
            id: "fast-model",
            additionalSpeedTiers: ["fast"],
        });
        const slowModel = createTestModel({id: "slow-model"});

        vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({userId: null, account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            models: [fastModel, slowModel],
            collaborationMode: "default",
            currentServiceTier,
            additionalDirectories: [],
        });

        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo,
            ...(clientCapabilities ? {clientCapabilities} : {}),
        });

        const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
        return {fixture, codexAcpAgent, codexAcpClient, response};
    }

    function setupPromptSession(fastModeEnabled: boolean, currentModelSupportsFast: boolean) {
        const {mockFixture, turnStartSpy} = setupPromptTestSession({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            fastModeEnabled,
            currentModelSupportsFast,
        });
        return {codexAcpAgent: mockFixture.getCodexAcpAgent(), turnStartSpy};
    }

    it("returns the Fast mode config option defaulted to Off for new sessions", async () => {
        const {response} = await createSession();

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("returns the Fast mode config option as a boolean when the client supports it", async () => {
        const {response} = await createSession(null, null, booleanConfigCapabilities);

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        const option = response.configOptions?.find(option => option.id === FAST_MODE_CONFIG_ID);
        expect(option).toMatchObject({
            id: FAST_MODE_CONFIG_ID,
            type: "boolean",
            currentValue: false,
        });
        expect(option).not.toHaveProperty("options");
    });

    it("keeps the Fast mode select option when boolean support is explicitly absent", async () => {
        const {response} = await createSession(null, null, {
            session: {
                configOptions: {
                    boolean: null,
                },
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it.each([
        {serviceTier: "fast", enabled: true},
        {serviceTier: "priority", enabled: true},
        {serviceTier: "flex", enabled: false},
        {serviceTier: null, enabled: false},
        {serviceTier: "unknown", enabled: false},
    ])("preserves Fast mode from the app-server tier $serviceTier through the first prompt", async ({serviceTier, enabled}) => {
        const {fixture, response, codexAcpAgent} = await createSession(serviceTier);
        const turnStartSpy = mockPromptTurn(fixture, "session-id");

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(enabled));

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: enabled ? "fast" : null,
        }));
    });

    it("omits Fast mode config options for JetBrains 2026.1 IntelliJ clients", async () => {
        const {response, fixture, codexAcpAgent} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.1.1",
            title: "WebStorm 2026.1.1",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toBeUndefined();
        await codexAcpAgent.setSessionConfigOption({sessionId: response.sessionId, configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON});
        expect(fixture.getAcpConnectionEvents([]).some(event =>
            event.method === "sessionUpdate" && event.args[0]?.update?.sessionUpdate === "config_option_update")).toBe(false);
    });

    it("omits Fast mode config options for JetBrains 2026.1 clients by name", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.IDE",
            version: "2026.1",
            title: "JetBrains IDE",
        });

        expect(response.configOptions).toBeUndefined();
    });

    it("keeps Fast mode config options for JetBrains clients outside 2026.1", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.2.0",
            title: "WebStorm 2026.2.0",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("keeps Fast mode config options for non-JetBrains 2026.1 clients", async () => {
        const {response} = await createSession(null, {
            name: "VSCode",
            version: "2026.1.1",
            title: "VS Code",
            _meta: {
                platform: "vscode",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("toggles Fast mode through session config options", async () => {
        const {codexAcpAgent} = await createSession();

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_ON,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_OFF,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);
    });

    it("toggles Fast mode through boolean session config options", async () => {
        const {codexAcpAgent} = await createSession(null, null, booleanConfigCapabilities);

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: true,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: false,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);
    });

    it("rejects unknown Fast mode config ids and values", async () => {
        const {codexAcpAgent} = await createSession();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: "unknown-config",
            value: FAST_MODE_ON,
        })).rejects.toThrow();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: "turbo",
        })).rejects.toThrow();
    });

    it("sends the fast service tier when Fast mode is enabled for a fast-capable model", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, true);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: "fast",
        }));
    });

    it("explicitly clears service tier when Fast mode is off", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(false, true);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("explicitly clears service tier when the selected model does not support fast", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("removes the Fast mode config option when switching to a non-fast model via session_config", async () => {
        const {codexAcpAgent} = await createSession("fast");

        const fastResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "fast-model",
        });
        expect(fastResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(true);

        const slowResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });
        expect(slowResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(false);
    });

    it("keeps Fast mode selected across model switches but stops applying it for non-fast models", async () => {
        const {codexAcpAgent, codexAcpClient, fixture} = await createSession("fast");
        const slowModel = createTestModel({id: "slow-model"});
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([slowModel]);
        const turnStartSpy = mockPromptTurn(fixture, "session-id");

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "slow-model[medium]",
        });

        const sessionState = codexAcpAgent.getSessionState("session-id");
        expect(sessionState.fastModeEnabled).toBe(true);
        expect(sessionState.currentModelSupportsFast).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            model: "slow-model",
            serviceTier: null,
        }));
    });

    describe("Ultrafast speed tier select", () => {
        async function createMultiTierSession(
            currentServiceTier: string | null = null,
            clientCapabilities: acp.ClientCapabilities = booleanConfigCapabilities,
        ) {
            const fixture = createCodexMockTestFixture();
            const codexAcpAgent = fixture.getCodexAcpAgent();
            const codexAcpClient = fixture.getCodexAcpClient();
            const ultrafastModel = createTestModel({
                id: "gpt-6.2-sol",
                additionalSpeedTiers: ["fast", "ultrafast"],
                serviceTiers: [
                    {id: "priority", name: "Fast", description: "2x speed, increased usage"},
                    {id: "ultrafast", name: "Ultrafast", description: "The fastest available responses for latency-sensitive work."},
                ],
            });
            const fastOnlyModel = createTestModel({
                id: "gpt-6.2-astra",
                additionalSpeedTiers: ["fast"],
                serviceTiers: [
                    {id: "priority", name: "Fast", description: "2x speed, increased usage"},
                ],
            });
            const slowModel = createTestModel({id: "slow-model"});

            vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
            vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({userId: null, account: null, requiresOpenaiAuth: false});
            vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
                sessionId: "session-id",
                currentModelId: "gpt-6.2-sol[medium]",
                models: [ultrafastModel, fastOnlyModel, slowModel],
                collaborationMode: "default",
                currentServiceTier,
                additionalDirectories: [],
            });

            await codexAcpAgent.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities,
            });

            const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
            return {fixture, codexAcpAgent, response};
        }

        it("exposes a Standard/Fast/Ultrafast select and declares per-model speedTiers", async () => {
            const {response} = await createMultiTierSession();

            const speedOption = response.configOptions?.find(option => option.id === FAST_MODE_CONFIG_ID);
            expect(speedOption).toEqual({
                id: FAST_MODE_CONFIG_ID,
                name: "Speed",
                description: "Response speed tier for the session",
                category: "model_config",
                type: "select",
                currentValue: FAST_MODE_OFF,
                options: [
                    {value: FAST_MODE_OFF, name: "Standard", description: "Default speed, normal usage"},
                    {value: FAST_MODE_FAST, name: "Fast", description: "2x speed, increased usage"},
                    {
                        value: FAST_MODE_ULTRAFAST,
                        name: "Ultrafast",
                        description: "The fastest available responses for latency-sensitive work.",
                    },
                ],
            });

            const lodyMeta = (response._meta as Record<string, unknown> | undefined)?.["lody"] as
                | { modelCapabilities?: { models?: Record<string, unknown> } }
                | undefined;
            expect(lodyMeta?.modelCapabilities?.models).toEqual({
                "gpt-6.2-sol": {effortValues: ["medium"], fastMode: true, speedTiers: ["fast", "ultrafast"]},
                "gpt-6.2-astra": {effortValues: ["medium"], fastMode: true},
                "slow-model": {effortValues: ["medium"], fastMode: false},
            });
        });

        it.each([
            {tier: FAST_MODE_ULTRAFAST, expectedServiceTier: "ultrafast"},
            {tier: FAST_MODE_FAST, expectedServiceTier: "fast"},
            {tier: FAST_MODE_OFF, expectedServiceTier: null},
        ])("applies $tier via v1 and v2 config options and forwards serviceTier=$expectedServiceTier", async ({tier, expectedServiceTier}) => {
            const {fixture, codexAcpAgent} = await createMultiTierSession();
            const turnStartSpy = mockPromptTurn(fixture, "session-id");

            const v2Response = await codexAcpAgent.setSessionConfigOptionV2({
                sessionId: "session-id",
                configId: FAST_MODE_CONFIG_ID,
                type: "id",
                value: tier,
            });
            const v2Option = v2Response.configOptions.find(option => option.configId === FAST_MODE_CONFIG_ID);
            expect(v2Option).toMatchObject({type: "select", currentValue: tier});

            await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});
            expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
                serviceTier: expectedServiceTier,
            }));
        });

        it("accepts legacy boolean and on/off values on a multi-tier model", async () => {
            const {fixture, codexAcpAgent} = await createMultiTierSession();
            const turnStartSpy = mockPromptTurn(fixture, "session-id");

            const boolOn = await codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: FAST_MODE_CONFIG_ID,
                type: "boolean",
                value: true,
            });
            expect(boolOn.configOptions.find(o => o.id === FAST_MODE_CONFIG_ID)).toMatchObject({
                type: "select",
                currentValue: FAST_MODE_FAST,
            });

            await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});
            expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({serviceTier: "fast"}));

            const boolOff = await codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: FAST_MODE_CONFIG_ID,
                type: "boolean",
                value: false,
            });
            expect(boolOff.configOptions.find(o => o.id === FAST_MODE_CONFIG_ID)).toMatchObject({
                type: "select",
                currentValue: FAST_MODE_OFF,
            });
        });

        it("preserves initial ultrafast tier and does not send ultrafast after switching to a fast-only or non-fast model", async () => {
            const {fixture, codexAcpAgent, response} = await createMultiTierSession("ultrafast");
            const turnStartSpy = mockPromptTurn(fixture, "session-id");

            expect(response.configOptions?.find(o => o.id === FAST_MODE_CONFIG_ID)).toMatchObject({
                type: "select",
                currentValue: FAST_MODE_ULTRAFAST,
            });

            // Switch to Fast-only model: reverts to boolean toggle (off), never submits ultrafast.
            const fastOnlyResponse = await codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: MODEL_CONFIG_ID,
                value: "gpt-6.2-astra",
            });
            expect(fastOnlyResponse.configOptions.find(o => o.id === FAST_MODE_CONFIG_ID)).toEqual(
                createFastModeConfigOption(false, true),
            );
            await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});
            expect(turnStartSpy).toHaveBeenLastCalledWith(expect.objectContaining({
                model: "gpt-6.2-astra",
                serviceTier: null,
            }));

            // Rejects ultrafast while on a Fast-only model.
            await expect(codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: FAST_MODE_CONFIG_ID,
                value: FAST_MODE_ULTRAFAST,
            })).rejects.toThrow();

            // Switching to non-fast model removes the speed option and sends null.
            const slowResponse = await codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: MODEL_CONFIG_ID,
                value: "slow-model",
            });
            expect(slowResponse.configOptions.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(false);
            await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});
            expect(turnStartSpy).toHaveBeenLastCalledWith(expect.objectContaining({
                model: "slow-model",
                serviceTier: null,
            }));

            // Switching back to the multi-tier model restores ultrafast.
            const backResponse = await codexAcpAgent.setSessionConfigOption({
                sessionId: "session-id",
                configId: MODEL_CONFIG_ID,
                value: "gpt-6.2-sol",
            });
            expect(backResponse.configOptions.find(o => o.id === FAST_MODE_CONFIG_ID)).toMatchObject({
                type: "select",
                currentValue: FAST_MODE_ULTRAFAST,
            });
        });
    });
});
