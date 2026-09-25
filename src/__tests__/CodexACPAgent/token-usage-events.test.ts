import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { TokenUsageBreakdown } from '../../app-server/v2';
import { ACP_EXT_SESSION_USAGE_UPDATE_METHOD } from '../../AcpExtensions';
import { CodexTurnUsage } from '../../CodexUsage';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    }
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId: 'turn-id',
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    const native = (inputTokens: number): TokenUsageBreakdown => ({
        inputTokens, totalTokens: inputTokens, cachedInputTokens: 0,
        cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    });
    const snapshot = (turnId: string, total: number, last = total) => ({
        threadId: 's', turnId,
        tokenUsage: {total: native(total), last: native(last), modelContextWindow: null},
    });

    it('attributes only each turn increment and freezes its model, without counting duplicate snapshots', () => {
        const tracker = new CodexTurnUsage(true);
        tracker.start('a', 'model-a');
        const a = tracker.update(snapshot('a', 10000));
        tracker.start('a', 'changed-mid-turn');
        expect(tracker.update(snapshot('a', 10000))).toBeUndefined();
        tracker.start('b', 'model-b');
        const b = tracker.update(snapshot('b', 12000, 2000));
        expect(a?.modelUsage).toEqual({'model-a': {
            inputTokens: 10000, outputTokens: 0, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        }});
        expect(b?.modelUsage).toEqual({'model-b': {
            inputTokens: 2000, outputTokens: 0, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        }});
        expect([a?._meta.lody.usageScopeId, b?._meta.lody.usageScopeId]).toEqual(['a', 'b']);
        expect(b?._meta.codex.usageTurnId).toBe('b');
        expect(a?.usage.inputTokens).toBe(10000);
    });

    it.each([false, true])('excludes resume/fork history with native replay=%s', replay => {
        const tracker = new CodexTurnUsage(false, replay ? undefined : native(10000));
        if (replay) expect(tracker.update(snapshot('history', 10000))).toBeUndefined();
        tracker.start('new', 'model-b');
        expect(tracker.update(snapshot('new', 10200, 200))?.usage.inputTokens).toBe(200);
        expect(tracker.update(snapshot('new', 10300, 100))?.usage.inputTokens).toBe(300);
    });

    it('keeps turn totals across native resets and ignores late previous-turn notifications', () => {
        const tracker = new CodexTurnUsage();
        tracker.start('a', 'model-a');
        tracker.update(snapshot('a', 100));
        tracker.start('b', 'model-b');
        expect(tracker.update(snapshot('a', 100))).toBeUndefined();
        expect(tracker.update(snapshot('b', 150, 50))?.usage.inputTokens).toBe(50);
        expect(tracker.update(snapshot('b', 0, 0))).toBeUndefined();
        expect(tracker.update(snapshot('b', 20))?.usage.inputTokens).toBe(70);
        expect(tracker.update(snapshot('b', 20))).toBeUndefined();
    });

    it('uses the submitted model across a delayed start and native goal continuations', () => {
        const tracker = new CodexTurnUsage(true);
        tracker.prepare('submitted-a');
        tracker.start('a', 'new-ui-b');
        expect(Object.keys(tracker.update(snapshot('a', 100))?.modelUsage ?? {})).toEqual(['submitted-a']);
        tracker.start('continuation', 'new-ui-b');
        expect(Object.keys(tracker.update(snapshot('continuation', 150))?.modelUsage ?? {})).toEqual(['submitted-a']);
    });

    it('does not bill a replayed last response when the resume snapshot is missing', () => {
        const tracker = new CodexTurnUsage();
        tracker.start('new', 'model-b');
        expect(tracker.update(snapshot('new', 10000, 1000))).toBeUndefined();
        expect(tracker.update(snapshot('new', 10200, 200))?.usage.inputTokens).toBe(200);
    });

    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                mockFixture.sendServerNotification({method: 'turn/started', params: {
                    threadId: sessionId, turn: {id: 'turn-id', items: [], status: 'inProgress', error: null},
                }});
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({sessionId, turnUsage: new CodexTurnUsage(false, native(0))}));

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should use last token usage from multiple updates', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                mockFixture.sendServerNotification({method: 'turn/started', params: {
                    threadId: sessionId, turn: {id: 'turn-id', items: [], status: 'inProgress', error: null},
                }});
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({sessionId, turnUsage: new CodexTurnUsage(false, native(0))}));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit turn-scoped usage from native cumulative differences', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            expect(events).toContainEqual({
                method: 'notify',
                args: [
                    ACP_EXT_SESSION_USAGE_UPDATE_METHOD,
                    expect.objectContaining({
                        sessionId,
                        usage: {
                            inputTokens: 3000,
                            outputTokens: 800,
                            cacheReadInputTokens: 1000,
                            cacheCreationInputTokens: 0,
                            reasoningOutputTokens: 100,
                            contextWindow: 128000,
                        },
                        modelUsage: { 'model-id': {
                            inputTokens: 3000, outputTokens: 800, cacheReadInputTokens: 1000,
                            cacheCreationInputTokens: 0, reasoningOutputTokens: 100,
                        } },
                    }),
                ],
            });
        });

        it('uses only native totals even when raw responses and reroutes arrive', async () => {
            const raw = {
                totalTokens: 110,
                inputTokens: 100,
                cachedInputTokens: 40,
                cacheWriteInputTokens: 60,
                outputTokens: 10,
                reasoningOutputTokens: 5,
            };
            const events = await setupPromptAndReturnEvents([
                {
                    method: 'model/rerouted',
                    params: {
                        threadId: sessionId,
                        turnId: 'turn-id',
                        fromModel: 'gpt-5.2-codex',
                        toModel: 'gpt-5.3-codex',
                        reason: 'highRiskCyberActivity',
                    },
                } as ServerNotification,
                {
                    method: 'rawResponse/completed',
                    params: {
                        threadId: sessionId,
                        turnId: 'turn-id',
                        responseId: 'response-1',
                        usage: raw,
                        usageMetadata: null,
                    },
                } as ServerNotification,
            ])();

            expect(events.filter(event => event.method === 'notify'
                && event.args[0] === ACP_EXT_SESSION_USAGE_UPDATE_METHOD)).toEqual([]);
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            const usageUpdateEvents = events.filter(event => event.method === 'sessionUpdate');
            await expect(`${JSON.stringify(usageUpdateEvents, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events.filter(event => event.method === 'sessionUpdate')).toEqual([]);
            expect(events).toContainEqual({
                method: 'notify',
                args: [
                    ACP_EXT_SESSION_USAGE_UPDATE_METHOD,
                    expect.objectContaining({
                        sessionId,
                        usage: {
                            inputTokens: 3000,
                            outputTokens: 800,
                            cacheReadInputTokens: 1000,
                            cacheCreationInputTokens: 0,
                            reasoningOutputTokens: 100,
                        },
                    }),
                ],
            });
        });
    });
});
