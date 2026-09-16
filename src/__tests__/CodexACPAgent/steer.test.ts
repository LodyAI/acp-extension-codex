import {afterEach, describe, expect, it, vi} from "vitest";
import {CODEX_STEER_APPLIED_METHOD, SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {setupPromptTestSession} from "../acp-test-utils";
import type {Thread, ThreadItem, TurnCompletedNotification} from "../../app-server/v2";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {promise, resolve, reject};
}

const steeredItem: ThreadItem = {
    type: "userMessage", id: "item-1", clientId: "steer-1",
    content: [{type: "text", text: "change direction", text_elements: []}],
};

function historyThread(overrides: Partial<Thread> = {}): Thread {
    return {
        id: "session-id", sessionId: "session-id", forkedFromId: null, parentThreadId: null,
        preview: "start", ephemeral: false, section: null, sectionEnteredAt: null,
        projectId: null, historyMode: "legacy", modelProvider: "openai", model: null,
        reasoningEffort: null, createdAt: 1, updatedAt: 2, recencyAt: null,
        status: {type: "idle"}, path: null, cwd: "/repo", cliVersion: "0.153.4",
        source: "appServer", threadSource: null, agentNickname: null, agentRole: null,
        gitInfo: null, name: null,
        turns: [{
            id: "turn-id", items: [steeredItem], itemsView: "full", status: "completed",
            error: null, startedAt: null, completedAt: null, durationMs: null,
        }],
        ...overrides,
    };
}

async function startPendingSteer() {
    const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession();
    const appServer = mockFixture.getCodexAppServerClient();
    const agent = mockFixture.getCodexAcpAgent();
    const completion = deferred<TurnCompletedNotification>();
    const started = deferred<void>();
    const submitted = deferred<void>();
    const steerResponse = deferred<{turnId: string}>();
    const cancellation = new AbortController();
    vi.spyOn(appServer, "awaitTurnCompleted").mockReturnValue(completion.promise);
    const turnSteerSpy = vi.spyOn(appServer, "turnSteer").mockImplementation(() => {
        submitted.resolve();
        return steerResponse.promise;
    });
    const originalPrompt = agent.prompt({
        sessionId: sessionState.sessionId,
        prompt: [{type: "text", text: "start"}],
    }, cancellation.signal, started.resolve);
    await started.promise;
    const request = agent.extMethod(SESSION_STEERING_METHOD, {
        sessionId: sessionState.sessionId,
        prompt: [{type: "text", text: "change direction"}],
        steerId: "steer-1",
    });
    // Observe errors immediately, even when the test first awaits prompt cleanup.
    void request.catch(() => {});
    await submitted.promise;
    return {
        mockFixture, sessionState, appServer, agent, request, steerResponse,
        turnStartSpy, turnSteerSpy, cancellation,
        async finishTurn(status: "completed" | "interrupted" = "completed") {
            completion.resolve({
                threadId: sessionState.sessionId,
                turn: {...historyThread().turns[0]!, items: [], status},
            });
            await originalPrompt;
        },
        notifyApplied() {
            mockFixture.sendServerNotification({
                method: "item/completed",
                params: {threadId: sessionState.sessionId, turnId: "turn-id", completedAtMs: 1, item: steeredItem},
            });
        },
        appliedNotifications() {
            return mockFixture.getAcpConnectionEvents([]).filter(event =>
                event.method === "notify" && event.args[0] === CODEX_STEER_APPLIED_METHOD);
        },
    };
}

describe("CodexACPAgent - steer", () => {
    afterEach(() => vi.useRealTimers());

    it("reconciles a lost response from persisted identity after the original prompt has closed", async () => {
        const test = await startPendingSteer();
        const read = vi.spyOn(test.appServer, "threadRead").mockResolvedValue({thread: historyThread()});
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));

        await expect(test.request).resolves.toEqual({outcome: "injected"});
        expect(read).toHaveBeenCalledWith({threadId: "session-id", includeTurns: true});
        expect(test.appliedNotifications()).toEqual([{
            method: "notify", args: [CODEX_STEER_APPLIED_METHOD, {sessionId: "session-id", steerId: "steer-1"}],
        }]);
        expect(test.turnStartSpy).toHaveBeenCalledOnce();
        expect(test.turnSteerSpy).toHaveBeenCalledOnce();
    });

    it("drains a queued applied notification before classifying a lost response", async () => {
        const test = await startPendingSteer();
        const read = vi.spyOn(test.appServer, "threadRead");
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));
        test.notifyApplied();
        await expect(test.request).resolves.toEqual({outcome: "injected"});
        expect(test.appliedNotifications()).toHaveLength(1);
        expect(read).not.toHaveBeenCalled();
    });

    it("keeps live positive evidence when the response subsequently fails", async () => {
        const test = await startPendingSteer();
        const read = vi.spyOn(test.appServer, "threadRead");
        test.notifyApplied();
        await test.mockFixture.getCodexAcpClient().waitForSessionNotifications("session-id");
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));
        await expect(test.request).resolves.toEqual({outcome: "injected"});
        expect(test.appliedNotifications()).toHaveLength(1);
        expect(read).not.toHaveBeenCalled();
    });

    it("accepts a late notification while history is stalled, without a second acknowledgement", async () => {
        const test = await startPendingSteer();
        const reading = deferred<void>();
        const history = deferred<{thread: Thread}>();
        vi.spyOn(test.appServer, "threadRead").mockImplementation(() => {
            reading.resolve();
            return history.promise;
        });
        test.steerResponse.reject(new Error("lost steer response"));
        await reading.promise;
        test.notifyApplied();
        await expect(test.request).resolves.toEqual({outcome: "injected"});
        history.resolve({thread: historyThread()});
        await test.finishTurn();
        test.notifyApplied();
        await test.mockFixture.getCodexAcpClient().waitForSessionNotifications("session-id");
        expect(test.appliedNotifications()).toHaveLength(1);
    });

    it.each([
        ["missing input", historyThread({turns: []})],
        ["same text without identity", historyThread({turns: [{
            ...historyThread().turns[0]!, items: [{...steeredItem, clientId: null}],
        }]})],
        ["another steer", historyThread({turns: [{
            ...historyThread().turns[0]!, items: [{...steeredItem, clientId: "steer-other"}],
        }]})],
        ["another turn", historyThread({turns: [{...historyThread().turns[0]!, id: "turn-other"}]})],
        ["another thread", historyThread({id: "replacement-thread"})],
    ])("preserves unknown for %s even after turn completion", async (_reason, thread) => {
        const test = await startPendingSteer();
        vi.spyOn(test.appServer, "threadRead").mockResolvedValue({thread});
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));
        await expect(test.request).rejects.toThrow("lost steer response");
        expect(test.appliedNotifications()).toEqual([]);
        expect(test.turnStartSpy).toHaveBeenCalledOnce();
        expect(test.turnSteerSpy).toHaveBeenCalledOnce();
    });

    it("preserves unknown when history is unavailable", async () => {
        const test = await startPendingSteer();
        vi.spyOn(test.appServer, "threadRead").mockRejectedValue(new Error("unsupported history read"));
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));
        await expect(test.request).rejects.toThrow("lost steer response");
        expect(test.appliedNotifications()).toEqual([]);
    });

    it("bounds the history read and ignores positive results after unknown is returned", async () => {
        vi.useFakeTimers();
        const test = await startPendingSteer();
        const reading = deferred<void>();
        const history = deferred<{thread: Thread}>();
        vi.spyOn(test.appServer, "threadRead").mockImplementation(() => {
            reading.resolve();
            return history.promise;
        });
        await test.finishTurn();
        test.steerResponse.reject(new Error("lost steer response"));
        await reading.promise;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(test.request).rejects.toThrow("lost steer response");
        history.resolve({thread: historyThread()});
        test.notifyApplied();
        await test.mockFixture.getCodexAcpClient().waitForSessionNotifications("session-id");
        expect(test.appliedNotifications()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves persisted application when Stop closes the prompt during reconciliation", async () => {
        const test = await startPendingSteer();
        const reading = deferred<void>();
        const interrupted = deferred<void>();
        const history = deferred<{thread: Thread}>();
        vi.spyOn(test.appServer, "threadRead").mockImplementation(() => {
            reading.resolve();
            return history.promise;
        });
        vi.spyOn(test.appServer, "turnInterrupt").mockImplementation(async () => {
            interrupted.resolve();
            return {};
        });
        test.steerResponse.reject(new Error("lost steer response"));
        await reading.promise;
        test.cancellation.abort();
        await interrupted.promise;
        await test.finishTurn("interrupted");
        history.resolve({thread: historyThread()});
        await expect(test.request).resolves.toEqual({outcome: "injected"});
        expect(test.appliedNotifications()).toHaveLength(1);
        expect(test.turnStartSpy).toHaveBeenCalledOnce();
        expect(test.turnSteerSpy).toHaveBeenCalledOnce();
    });

    it("steers the active app-server turn and acknowledges its committed user message", async () => {
        const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession();
        const appServer = mockFixture.getCodexAppServerClient();
        const completion = deferred<TurnCompletedNotification>();
        const steerResponse = deferred<{turnId: string}>();
        vi.spyOn(appServer, "awaitTurnCompleted").mockReturnValue(completion.promise);
        const turnSteerSpy = vi.spyOn(appServer, "turnSteer").mockReturnValue(steerResponse.promise);

        const originalPrompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "start"}],
        });
        await vi.waitFor(() => expect(turnStartSpy).toHaveBeenCalledOnce());

        const steerPrompt = mockFixture.getCodexAcpAgent().extMethod(SESSION_STEERING_METHOD, {
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "change direction"}],
            steerId: "steer-1",
        });
        await vi.waitFor(() => expect(turnSteerSpy).toHaveBeenCalledWith({
            threadId: sessionState.sessionId,
            input: [{type: "text", text: "change direction", text_elements: []}],
            expectedTurnId: "turn-id",
            clientUserMessageId: "steer-1",
        }));
        expect(turnStartSpy).toHaveBeenCalledOnce();
        expect(mockFixture.getAcpConnectionEvents([])).not.toContainEqual(expect.objectContaining({
            method: "notify",
            args: [CODEX_STEER_APPLIED_METHOD, expect.anything()],
        }));

        mockFixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: sessionState.sessionId,
                turnId: "turn-id",
                completedAtMs: 1,
                item: {
                    type: "userMessage",
                    id: "item-1",
                    clientId: "steer-1",
                    content: [{type: "text", text: "change direction", text_elements: []}],
                },
            },
        });
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionState.sessionId);
        expect(mockFixture.getAcpConnectionEvents([])).toContainEqual({
            method: "notify",
            args: [CODEX_STEER_APPLIED_METHOD, {
                sessionId: sessionState.sessionId,
                steerId: "steer-1",
            }],
        });

        steerResponse.resolve({turnId: "turn-id"});
        completion.resolve({
            threadId: sessionState.sessionId,
            turn: {
                id: "turn-id",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        await expect(originalPrompt).resolves.toMatchObject({stopReason: "end_turn"});
        await expect(steerPrompt).resolves.toEqual({outcome: "injected"});
    });

    it("rejects an unmarked concurrent prompt instead of starting an ambiguous turn", async () => {
        const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession();
        const completion = deferred<TurnCompletedNotification>();
        vi.spyOn(mockFixture.getCodexAppServerClient(), "awaitTurnCompleted").mockReturnValue(completion.promise);
        const originalPrompt = mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "start"}],
        });
        await vi.waitFor(() => expect(turnStartSpy).toHaveBeenCalledOnce());

        await expect(mockFixture.getCodexAcpAgent().prompt({
            sessionId: sessionState.sessionId,
            prompt: [{type: "text", text: "ambiguous"}],
        })).rejects.toThrow("Invalid request");
        expect(turnStartSpy).toHaveBeenCalledOnce();
        completion.resolve({
            threadId: sessionState.sessionId,
            turn: {
                id: "turn-id",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        });
        await originalPrompt;
    });
});
