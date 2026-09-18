import {describe, expect, it, vi} from "vitest";
import type {Thread} from "../../app-server/v2";
import {createCodexMockTestFixture} from "../acp-test-utils";

describe("CodexACPAgent - readSessionHistory", () => {
    it("replays paginated Core history in order without acquiring a live session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const native = fixture.getCodexAppServerClient();
        const thread = createHistoryThread();
        const older = thread.turns[0]!;
        const newer = {
            ...older, id: "turn-2",
            items: [{...older.items[1]!, id: "agent-2", text: "Later answer"}],
        };
        const resume = vi.spyOn(native, "threadResume");
        const start = vi.spyOn(native, "turnStart");
        vi.spyOn(native, "threadRead").mockResolvedValue({
            thread: {...thread, historyMode: "paginated", turns: []},
        });
        const pages = vi.spyOn(native, "threadTurnsList")
            .mockResolvedValueOnce({data: [newer], nextCursor: "older", backwardsCursor: null})
            .mockResolvedValueOnce({data: [older], nextCursor: null, backwardsCursor: null});

        await expect(agent.readSessionHistory({sessionId: thread.id})).resolves.toEqual({});

        expect(pages).toHaveBeenCalledTimes(2);
        expect(resume).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(() => agent.getSessionState(thread.id)).toThrow("Session session-1 not found");
        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot("data/lody-paginated-history.json");
    });

    it("reads and projects history without resuming or installing the session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const appServer = fixture.getCodexAppServerClient();
        const threadResume = vi.spyOn(appServer, "threadResume")
            .mockRejectedValue(new Error("thread already has an active writer"));
        const threadRead = vi.spyOn(appServer, "threadRead").mockResolvedValue({
            thread: createHistoryThread(),
        });

        await expect(agent.readSessionHistory({sessionId: "session-1"})).resolves.toEqual({});

        expect(threadRead).toHaveBeenCalledTimes(2);
        expect(threadRead).toHaveBeenCalledWith({
            threadId: "session-1",
            includeTurns: true,
        });
        expect(threadResume).not.toHaveBeenCalled();
        expect(() => agent.getSessionState("session-1")).toThrow("Session session-1 not found");
        expect(fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]))
            .toEqual([
                {
                    sessionId: "session-1",
                    update: {
                        sessionUpdate: "session_info_update",
                        title: "Imported conversation",
                        _meta: {
                            lody: {
                                titleSource: "explicit",
                            },
                        },
                    },
                },
                {
                    sessionId: "session-1",
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId: "user-1",
                        content: {
                            type: "text",
                            text: "Hello",
                        },
                    },
                },
                {
                    sessionId: "session-1",
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "agent-1",
                        content: {
                            type: "text",
                            text: "Hi there",
                        },
                        _meta: {
                            lody: {
                                turnId: "turn-1",
                            },
                        },
                    },
                },
            ]);
    });
});

function createHistoryThread(): Thread {
    return {
        id: "session-1",
        sessionId: "session-1",
        forkedFromId: null,
        parentThreadId: null,
        preview: "Hello",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: "/repo/project",
        cliVersion: "0.0.0",
        source: "cli",
        threadSource: null,
        originator: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: "Imported conversation",
        turns: [{
            id: "turn-1",
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items: [
                {
                    type: "userMessage",
                    id: "user-1",
                    clientId: null,
                    content: [{type: "text", text: "Hello", text_elements: []}],
                },
                {
                    type: "agentMessage",
                    id: "agent-1",
                    text: "Hi there",
                    phase: null,
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                },
            ],
        }],
    };
}
