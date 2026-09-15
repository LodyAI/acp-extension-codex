import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { TokenUsageBreakdown } from '../../app-server/v2';
import { ACP_EXT_SESSION_USAGE_UPDATE_METHOD } from '../../AcpExtensions';
import { CodexUsageAccounting, CODEX_UNATTRIBUTED_MODEL } from '../../CodexUsageAccounting';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach} from 'vitest';
import {createCodexUsageStore} from '../../CodexUsageBaselineStore';
import {renameSync} from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {...actual, renameSync: vi.fn(actual.renameSync)};
});

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
    const homes: string[] = [];
    const home = () => {
        const directory = mkdtempSync(join(tmpdir(), 'codex-usage-test-'));
        homes.push(directory);
        return directory;
    };
    afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, {recursive: true, force: true}); });
    const native = (input: number): TokenUsageBreakdown => ({totalTokens: input, inputTokens: input,
        cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0});
    const snapshot = (input: number) => ({threadId: 's', turnId: 't',
        tokenUsage: {total: native(input), last: native(input), modelContextWindow: 128000}});
    const rawResponse = (input: number, responseId: string) => ({threadId: 's', turnId: 't', responseId,
        usage: native(input), usageMetadata: null});

    it('excludes fork replay before the first paid response, including an idle restart', () => {
        const options = {threadId: 's', codexHome: home()};
        new CodexUsageAccounting({...options, forkFromHistory: true, usageBaseline: snapshot(1000)});
        const resumed = new CodexUsageAccounting(options);
        expect(resumed.update('s', snapshot(1000)).usage.inputTokens).toBe(0);
        expect(resumed.update('s', snapshot(1110)).usage.inputTokens).toBe(110);
        expect(new CodexUsageAccounting(options).update('s', snapshot(1120)).usage.inputTokens).toBe(120);
    });

    it('counts the first native-only response of an empty fork', () => {
        const ledger = new CodexUsageAccounting({forkFromHistory: true});
        expect(ledger.update('s', snapshot(10)).usage.inputTokens).toBe(10);
    });

    it('starts a fresh lifetime at the resume baseline when the sidecar is missing', () => {
        const options = {threadId: 's', codexHome: home()};
        const ledger = new CodexUsageAccounting({...options, usageBaseline: snapshot(1000)});
        expect(ledger.update('s', snapshot(1110)).usage.inputTokens).toBe(110);
        expect(ledger.update('s', snapshot(1110)).modelUsage[CODEX_UNATTRIBUTED_MODEL]?.inputTokens)
            .toBe(110);
        expect(new CodexUsageAccounting(options).update('s', snapshot(1120)).usage.inputTokens).toBe(120);
    });

    it('does not re-emit a resumed history baseline when exact attribution already has a ledger', () => {
        const options = {threadId: 's', codexHome: home()};
        const ledger = new CodexUsageAccounting(options);
        ledger.noteThreadModel('s', 'model-a');
        ledger.recordResponse('s', {...rawResponse(1000, 'history'), usage: native(1000)});
        const resumed = new CodexUsageAccounting({...options, usageBaseline: snapshot(1000)});
        const update = resumed.update('s', snapshot(1110));
        expect(update.usage.inputTokens).toBe(1110);
        expect(update.modelUsage['model-a']?.inputTokens).toBe(1000);
        expect(update.modelUsage[CODEX_UNATTRIBUTED_MODEL]?.inputTokens).toBe(110);
    });

    it.each(['before', 'at', 'after'])('restores the native cursor when restarting %s reset', (position) => {
        const options = {threadId: 's', codexHome: home()};
        let ledger = new CodexUsageAccounting(options);
        ledger.update('s', snapshot(1000));
        if (position === 'before') ledger = new CodexUsageAccounting(options);
        const reset = snapshot(0);
        reset.tokenUsage.total.totalTokens = 128000;
        ledger.update('s', reset);
        if (position === 'at') ledger = new CodexUsageAccounting(options);
        ledger.update('s', reset);
        expect(ledger.update('s', snapshot(10)).usage.inputTokens).toBe(1010);
        if (position === 'after') ledger = new CodexUsageAccounting(options);
        expect(ledger.update('s', snapshot(20)).usage.inputTokens).toBe(1020);
    });

    it('does not count a persisted exact response twice when its native total arrives after restart', () => {
        const options = {threadId: 's', codexHome: home()};
        const ledger = new CodexUsageAccounting(options);
        ledger.noteTurnModel('t', 'model-a');
        ledger.recordResponse('s', rawResponse(100, 'r'));
        const restored = new CodexUsageAccounting(options).update('s', snapshot(100));
        expect(restored.usage.inputTokens).toBe(100);
        expect(restored.modelUsage[CODEX_UNATTRIBUTED_MODEL]).toBeUndefined();
    });

    it('migrates a pre-cursor sidecar after native reset', () => {
        const options = {threadId: 's', codexHome: home()};
        createCodexUsageStore(options.codexHome, 's')!.save({version: 1, modelUsage: {
            [CODEX_UNATTRIBUTED_MODEL]: {inputTokens: 1010, outputTokens: 0, cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0, reasoningOutputTokens: 0},
        }});
        const ledger = new CodexUsageAccounting({...options, usageBaseline: snapshot(10)});
        expect(ledger.update('s', snapshot(20)).usage.inputTokens).toBe(1020);
        expect(new CodexUsageAccounting(options).update('s', snapshot(30)).usage.inputTokens).toBe(1030);
    });

    it.each([false, true])('retains a persisted raw response when restart replays reset (previous reset: %s)', (previousReset) => {
        const options = {threadId: 's', codexHome: home()};
        const ledger = new CodexUsageAccounting(options);
        const reset = snapshot(0);
        reset.tokenUsage.total.totalTokens = 128000;
        if (previousReset) ledger.update('s', reset);
        ledger.noteTurnModel('t', 'model-a');
        ledger.recordResponse('s', rawResponse(100, 'r'));
        const resumed = new CodexUsageAccounting({...options, usageBaseline: reset});
        resumed.update('s', reset);
        expect(resumed.update('s', snapshot(10)).usage.inputTokens).toBe(110);
    });

    it('keeps child history and reset epochs out of root totals while counting exact child responses', () => {
        const options = {threadId: 's', codexHome: home()};
        const ledger = new CodexUsageAccounting(options);
        ledger.recordResponse('s', rawResponse(100, 'root'));
        ledger.recordResponse('s', {...rawResponse(30, 'child'), threadId: 'child'});
        ledger.update('s', {...snapshot(1000), threadId: 'child'});
        expect(ledger.update('s', snapshot(110)).usage.inputTokens).toBe(140);
        const resumed = new CodexUsageAccounting(options);
        const reset = snapshot(0);
        reset.tokenUsage.total.totalTokens = 128000;
        resumed.update('s', {...reset, threadId: 'child'});
        resumed.update('s', reset);
        expect(resumed.update('s', snapshot(10)).usage.inputTokens).toBe(150);
    });

    it('preserves exact child usage when migrating a pending fork sidecar', () => {
        const options = {threadId: 's', codexHome: home()};
        createCodexUsageStore(options.codexHome, 's')!.save({version: 1, pendingForkExclusion: true, modelUsage: {
            'model-a': {inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0, reasoningOutputTokens: 0},
        }});
        const ledger = new CodexUsageAccounting({...options, usageBaseline: snapshot(1010)});
        expect(ledger.update('s', snapshot(1020)).usage.inputTokens).toBe(20);
        expect(new CodexUsageAccounting(options).update('s', snapshot(1030)).usage.inputTokens).toBe(30);
    });

    it('preserves the last complete sidecar when atomic replacement fails', () => {
        const directory = home();
        const store = createCodexUsageStore(directory, 's')!;
        const before = {version: 1 as const, modelUsage: {m: {inputTokens: 10, outputTokens: 0,
            cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0}}};
        store.save(before);
        const rename = vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('replacement failed'); });
        try {
            expect(() => store.save({version: 1, modelUsage: {m: {...before.modelUsage.m, inputTokens: 20}}})).toThrow('replacement failed');
            expect(store.load()?.modelUsage['m']?.inputTokens).toBe(10);
        } finally {
            rename.mockRestore();
        }
    });

    it('leaves previous-model compaction unattributed and resumes the requested model afterwards', () => {
        const ledger = new CodexUsageAccounting();
        ledger.noteTurnModel('t', 'new-model');
        ledger.setCompacting('s', true);
        expect(ledger.recordResponse('s', rawResponse(10, 'compact'))?.modelUsage[CODEX_UNATTRIBUTED_MODEL]?.inputTokens).toBe(10);
        ledger.setCompacting('s', false);
        const result = ledger.recordResponse('s', rawResponse(20, 'answer'));
        expect(result?.modelUsage['new-model']?.inputTokens).toBe(20);
        expect(result?.usage.inputTokens).toBe(30);
    });

    it('uses reroute evidence for one response only, even when usage is absent', () => {
        const ledger = new CodexUsageAccounting();
        ledger.noteTurnModel('t', 'requested');
        ledger.noteReroutedModel('t', 'actual');
        expect(ledger.recordResponse('s', rawResponse(10, 'first'))?.modelUsage['actual']?.inputTokens).toBe(10);
        ledger.noteReroutedModel('t', 'actual'); // A buffered notification can replay.
        expect(ledger.recordResponse('s', rawResponse(20, 'next'))?.modelUsage[CODEX_UNATTRIBUTED_MODEL]?.inputTokens).toBe(20);
        ledger.noteReroutedModel('other-turn', 'other');
        ledger.recordResponse('s', {...rawResponse(0, 'unknown'), turnId: 'other-turn', usage: null});
        expect(ledger.recordResponse('s', {...rawResponse(5, 'last'), turnId: 'other-turn'})?.modelUsage['other']).toBeUndefined();
    });
    it('keeps disjoint totals and delta across duplicates, model switches and native resets', () => {
        const ledger = new CodexUsageAccounting();
        const raw = {totalTokens: 110, inputTokens: 100, cachedInputTokens: 40,
            cacheWriteInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 5};
        const send = (total: TokenUsageBreakdown, last = total) => ledger.update('s', {
            threadId: 's', turnId: 't', tokenUsage: {total, last, modelContextWindow: 128000},
        });
        const first = send(raw);
        expect(first.modelUsage[CODEX_UNATTRIBUTED_MODEL]).toEqual({
            inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 40,
            cacheCreationInputTokens: 60, reasoningOutputTokens: 5,
        });
        expect(Object.values(first.delta.usage).reduce((a, b) => a + b, 0)).toBe(110);
        first.modelUsage[CODEX_UNATTRIBUTED_MODEL]!.inputTokens = 999;
        expect(send(raw).delta.usage.inputTokens).toBe(0);
        const reset = {totalTokens: 128000, inputTokens: 0, cachedInputTokens: 0,
            cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
        expect(send(reset).modelUsage[CODEX_UNATTRIBUTED_MODEL]?.cacheCreationInputTokens).toBe(60);
        send(reset);
        const next = send(raw);
        expect(next.modelUsage[CODEX_UNATTRIBUTED_MODEL]?.cacheCreationInputTokens).toBe(120);
        expect(next.delta.usage.cacheCreationInputTokens).toBe(60);
        expect(next.modelUsage[CODEX_UNATTRIBUTED_MODEL]?.costUSD).toBeUndefined();
    });

    it('attributes exact per-response usage to the active model', () => {
        const ledger = new CodexUsageAccounting();
        const raw = {totalTokens: 110, inputTokens: 100, cachedInputTokens: 40,
            cacheWriteInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 5};
        ledger.noteTurnModel('turn-id', 'gpt-5.3-codex');
        const response = ledger.recordResponse('s', {
            threadId: 's',
            turnId: 'turn-id',
            responseId: 'response-1',
            usage: raw,
            usageMetadata: null,
        });
        expect(response).toBeDefined();
        expect(response!.modelUsage['gpt-5.3-codex']).toEqual({
            inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 40,
            cacheCreationInputTokens: 60, reasoningOutputTokens: 5,
        });
        expect(response!.modelUsage[CODEX_UNATTRIBUTED_MODEL]).toBeUndefined();

        const update = ledger.update('s', {
            threadId: 's',
            turnId: 'turn-id',
            tokenUsage: {total: raw, last: raw, modelContextWindow: 128000},
        });
        expect(update.modelUsage['gpt-5.3-codex']).toEqual({
            inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 40,
            cacheCreationInputTokens: 60, reasoningOutputTokens: 5,
        });
        expect(update.modelUsage[CODEX_UNATTRIBUTED_MODEL]).toBeUndefined();
    });

    it('excludes fork source history and attributes only post-fork responses', () => {
        const source = {totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0,
            cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0};
        const ledger = new CodexUsageAccounting({forkFromHistory: true, usageBaseline: {
            threadId: 's', turnId: 'source', tokenUsage: {total: source, last: source, modelContextWindow: 128000},
        }});
        const fresh = {totalTokens: 110, inputTokens: 100, cachedInputTokens: 0,
            cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0};
        ledger.noteTurnModel('turn-id', 'gpt-5.3-codex');
        ledger.recordResponse('s', {
            threadId: 's',
            turnId: 'turn-id',
            responseId: 'response-1',
            usage: fresh,
            usageMetadata: null,
        });
        const total = {
            totalTokens: source.totalTokens + fresh.totalTokens,
            inputTokens: source.inputTokens + fresh.inputTokens,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: source.outputTokens + fresh.outputTokens,
            reasoningOutputTokens: 0,
        };
        const update = ledger.update('s', {
            threadId: 's',
            turnId: 'turn-id',
            tokenUsage: {total, last: fresh, modelContextWindow: 128000},
        });
        expect(update.modelUsage['gpt-5.3-codex']).toEqual({
            inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
        });
        expect(update.modelUsage[CODEX_UNATTRIBUTED_MODEL]).toBeUndefined();
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
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId,
                usageAccounting: new CodexUsageAccounting(),
            }));

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
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId,
                usageAccounting: new CodexUsageAccounting(),
            }));

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

        it('should emit session_usage_update ext notification with total token breakdown', async () => {
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
                        modelUsage: { [CODEX_UNATTRIBUTED_MODEL]: {
                            inputTokens: 3000, outputTokens: 800, cacheReadInputTokens: 1000,
                            cacheCreationInputTokens: 0, reasoningOutputTokens: 100,
                        } },
                    }),
                ],
            });
        });

        it('attributes raw response completions to the rerouted model', async () => {
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

            const usageEvent = events.find(
                (event) =>
                    event.method === 'notify' &&
                    event.args[0] === ACP_EXT_SESSION_USAGE_UPDATE_METHOD &&
                    typeof event.args[1] === 'object' &&
                    event.args[1] !== null &&
                    'modelUsage' in event.args[1]
            );
            expect(usageEvent).toBeDefined();
            expect((usageEvent?.args[1] as { modelUsage?: Record<string, unknown> }).modelUsage).toEqual({
                'gpt-5.3-codex': {
                    inputTokens: 0,
                    outputTokens: 5,
                    cacheReadInputTokens: 40,
                    cacheCreationInputTokens: 60,
                    reasoningOutputTokens: 5,
                },
            });
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
