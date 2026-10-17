import {describe, expect, it, vi} from "vitest";
import type {ThreadItem, ThreadItemEntry, ThreadItemsListParams, ThreadTurnsListParams, Turn} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

function messageTurn(id: string): Turn {
    return {
        id,
        items: [{type: "userMessage", id: `${id}-input`, clientId: null, content: [{type: "text", text: `Question ${id}`, text_elements: []}]}, {type: "agentMessage", id: `${id}-message`, text: `Answer ${id}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null}],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

/**
 * A fake of thread/turns/list over `stored`. A descending read without a
 * cursor starts at the newest turn, and the cursor `turn:<id>` starts at that
 * turn. An ascending read starts at the oldest turn.
 */
function turnStore(stored: Turn[], pageSize = 2) {
    return async ({cursor, limit, sortDirection}: ThreadTurnsListParams) => {
        if (sortDirection === "desc") {
            const index = cursor === null || cursor === undefined
                ? stored.length - 1
                : stored.findIndex(turn => `turn:${turn.id}` === cursor);
            const data = index < 0 ? [] : stored.slice(Math.max(0, index + 1 - (limit ?? 1)), index + 1).reverse();
            return {data: data.map(turn => ({...turn, items: [], itemsView: "notLoaded" as const})), nextCursor: null, backwardsCursor: null};
        }
        const start = cursor === null || cursor === undefined ? 0 : Number(cursor.slice("asc:".length));
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {data: stored.slice(start, end), nextCursor: end < stored.length ? `asc:${end}` : null, backwardsCursor: null};
    };
}

/**
 * A fake of thread/items/list over the items of `turns`. A descending read
 * without a cursor starts at the newest item, and the cursor `item:<id>`
 * starts at that item. An ascending read starts at the oldest item.
 */
function itemStore(turns: Turn[], pageSize = 2) {
    const entries = turns.flatMap(turn => turn.items.map(item => ({turnId: turn.id, item, startedAtMs: null, completedAtMs: null})));
    return async ({turnId, cursor, limit, sortDirection}: ThreadItemsListParams) => {
        if (cursor !== null && typeof cursor === "object") {
            throw new Error("This history fixture only supports opaque string cursors");
        }
        const scoped = entries.filter(entry => !turnId || entry.turnId === turnId);
        if (sortDirection === "desc") {
            const index = cursor === null || cursor === undefined
                ? scoped.length - 1
                : scoped.findIndex(entry => `item:${entry.item.id}` === cursor);
            return {data: index < 0 ? [] : [scoped[index]!], nextCursor: null, backwardsCursor: null};
        }
        const start = cursor === null || cursor === undefined ? 0 : Number(cursor.slice("asc:".length));
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {data: scoped.slice(start, end), nextCursor: end < scoped.length ? `asc:${end}` : null, backwardsCursor: null};
    };
}

async function collect(history: AsyncIterable<Array<ThreadItem | ThreadItemEntry>> | null): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of history ?? []) ids.push(...page.map(item => "turnId" in item ? item.item.id : item.id));
    return ids;
}

describe("paginated thread history", () => {
    it("loads every page in chronological order with complete messages", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const metadataRead = vi.spyOn(appServer, "threadRead").mockResolvedValue({
            thread: {id: "history", turns: [], name: "Saved conversation"} as any,
        });
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [messageTurn("third")], nextCursor: null, backwardsCursor: null})
            .mockResolvedValueOnce({data: [messageTurn("first"), messageTurn("second")], nextCursor: "next-page", backwardsCursor: null})
            .mockResolvedValueOnce({data: [messageTurn("third")], nextCursor: null, backwardsCursor: "previous-page"});

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");

        await expect(JSON.stringify({
            reads: metadataRead.mock.calls,
            pages: pages.mock.calls,
            thread,
        }, null, 2)).toMatchFileSnapshot("data/paginated-thread-history.json");
    });

    it("reads standalone legacy history without requiring a pagination API", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const history = {id: "legacy", historyMode: "legacy", turns: [messageTurn("first"), messageTurn("second")]};
        const read = vi.spyOn(appServer, "threadRead")
            .mockResolvedValueOnce({thread: {...history, turns: []} as any})
            .mockResolvedValueOnce({thread: history as any});
        const pages = vi.spyOn(appServer, "threadTurnsList").mockRejectedValue(new Error("Method not found"));

        expect(await fixture.getCodexAcpClient().readSessionThread("legacy")).toEqual(history);
        expect(read.mock.calls).toEqual([
            [{threadId: "legacy"}],
            [{threadId: "legacy", includeTurns: true}],
        ]);
        expect(pages).not.toHaveBeenCalled();
    });

    it("does not include turns appended while standalone history is being paged", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        const stored = [messageTurn("first"), messageTurn("second")];
        vi.spyOn(appServer, "threadTurnsList").mockImplementation(async ({cursor, sortDirection}) => {
            if (sortDirection === "desc") {
                const data = [stored.at(-1)!];
                stored.push(messageTurn("appended-during-read"));
                return {data, nextCursor: null, backwardsCursor: null};
            }
            const index = cursor === null ? 0 : Number(cursor);
            return {data: [stored[index]!], nextCursor: index + 1 < stored.length ? String(index + 1) : null, backwardsCursor: null};
        });

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");
        expect(thread.turns.map(turn => turn.id)).toEqual(["first", "second"]);
        expect(stored).toHaveLength(3);
    });

    it("rejects a cursor that returns to the initial resume boundary", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [], nextCursor: "resume-boundary", backwardsCursor: null})
            .mockRejectedValue(new Error("Unexpected extra page request"));

        await expect(appServer.threadReadHistory("history", "resume-boundary"))
            .rejects.toThrow("Codex returned a repeated thread history cursor");
        expect(pages).toHaveBeenCalledTimes(1);
    });

    it("returns an empty history when the first page is empty", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "empty", turns: []} as any});
        const pages = vi.spyOn(appServer, "threadTurnsList").mockResolvedValue({data: [], nextCursor: null, backwardsCursor: null});

        expect(await fixture.getCodexAcpClient().readSessionThread("empty")).toEqual({id: "empty", turns: []});
        expect(pages).toHaveBeenCalledTimes(1);
    });

    it.each([
        {name: "repeated cursor", cursors: ["page-a", "page-a"]},
        {name: "cursor cycle", cursors: ["page-a", "page-b", "page-a"]},
    ])("rejects a $name before requesting another page", async ({cursors}) => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockRejectedValue(new Error("Unexpected extra page request"))
            .mockResolvedValueOnce({data: [messageTurn("last")], nextCursor: null, backwardsCursor: null});
        for (const nextCursor of cursors) {
            pages.mockResolvedValueOnce({data: [], nextCursor, backwardsCursor: null});
        }

        await expect(fixture.getCodexAcpClient().readSessionThread("history"))
            .rejects.toThrow("cursor");
        expect(pages).toHaveBeenCalledTimes(cursors.length + 1);
    });

    it("rejects an incomplete history if a later page fails", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [messageTurn("first")], nextCursor: "next-page", backwardsCursor: null})
            .mockRejectedValueOnce(new Error("History unavailable"));

        await expect(fixture.getCodexAcpClient().readSessionThread("history")).rejects.toThrow("History unavailable");
    });
});
