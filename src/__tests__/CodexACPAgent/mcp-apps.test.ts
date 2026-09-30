import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it, vi} from "vitest";
import {ResponseError, type MessageConnection} from "vscode-jsonrpc/node";
import type {ServerNotification} from "../../app-server";
import type {Thread, ThreadItem} from "../../app-server/v2";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer, type SessionState} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {
    MCP_APP_LOAD_METHOD,
    MCP_APP_RESOURCE_READ_METHOD,
    MCP_APP_TOOL_CALL_METHOD,
} from "../../McpApps";
import {
    createBaseTestFixture,
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
} from "../acp-test-utils";
import {createMockConnections} from "./test-utils";

type AppToolCallItem = Extract<ThreadItem, {type: "mcpToolCall"}>;

const sessionId = "thread-app";
const mcpAppsClient: acp.ClientCapabilities = {_meta: {lody: {mcpApps: {version: 1}}}};
const resourceUri = "ui://graph/explorer.html";
const appResult = {
    content: [{type: "text", text: "3 nodes"}],
    structuredContent: {nodes: 3},
    _meta: null,
};

function appItem(overrides: Partial<AppToolCallItem> = {}): AppToolCallItem {
    return {
        type: "mcpToolCall",
        id: "call-app-1",
        server: "codex_apps",
        tool: "explore_graph",
        status: "inProgress",
        arguments: {query: "synthetic"},
        appContext: {
            connectorId: "connector-synthetic",
            linkId: null,
            resourceUri,
            appName: "Synthetic Graph",
            actionName: null,
        },
        mcpAppUi: {resourceUri, preferredModelDisplayMode: "inline"},
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
        ...overrides,
    };
}

function threadWith(items: ThreadItem[]): Thread {
    return {
        id: sessionId, sessionId, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
        section: null, sectionEnteredAt: null, projectId: null, historyMode: "legacy", modelProvider: "openai",
        model: null, reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null, status: {type: "idle"},
        path: null, cwd: "/repo", cliVersion: "0.0.0", source: "cli", threadSource: null, originator: null,
        agentNickname: null, agentRole: null, gitInfo: null, name: "Apps",
        turns: [{
            id: "turn-1", itemsView: "full", status: "completed", error: null,
            startedAt: null, completedAt: null, durationMs: null, items,
        }],
    };
}

type Handler = (params: any) => unknown;

/** App-server double that answers only the methods a test declares. */
function createAppServerFixture(handlers: Record<string, Handler>) {
    const connection = {
        sendRequest: async (method: string, params: unknown) => handlers[method]?.(params),
        onClose: () => ({dispose: () => {}}),
        onDispose: () => ({dispose: () => {}}),
        onUnhandledNotification: () => {},
        onNotification: () => {},
        onRequest: () => {},
        end: () => {},
    } as unknown as MessageConnection;
    const fixture = createBaseTestFixture({connection, getExitCode: () => null});
    const requests = (method: string) => fixture.getCodexConnectionEvents([])
        .filter((event): event is typeof event & {method: string; params: unknown} =>
            event.eventType === "request" && (event as {method?: string}).method === method)
        .map(event => event.params);
    return {fixture, agent: fixture.getCodexAcpAgent(), requests};
}

async function openSession(
    agent: CodexAcpServer,
    clientCapabilities: acp.ClientCapabilities | null = mcpAppsClient,
): Promise<SessionState> {
    await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, ...(clientCapabilities ? {clientCapabilities} : {})});
    const state = createTestSessionState({sessionId});
    (agent as unknown as {installSessionState(state: SessionState): void}).installSessionState(state);
    return state;
}

const completedApp = appItem({status: "completed", result: appResult});

function toolServer(visibility?: string[]): Handler {
    return () => ({
        data: [{
            name: "codex_apps",
            tools: {
                refresh_graph: {
                    name: "refresh_graph",
                    inputSchema: {type: "object"},
                    ...(visibility ? {_meta: {ui: {visibility}}} : {}),
                },
            },
        }],
        nextCursor: null,
    });
}

/** Connects an ACP client of `version` that negotiated MCP Apps and returns an untyped request sender. */
async function connectAndInitialize(version: "v1" | "v2", clientStream: acp.Stream) {
    if (version === "v1") {
        const connection = acp.client({name: "mcp-app-client"}).connect(clientStream);
        await connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: mcpAppsClient,
        });
        return {
            request: (method: string, params: unknown) => connection.agent.request(method, params),
            close: () => connection.close(),
        };
    }
    const connection = acpV2.client({name: "mcp-app-client"}).connect(clientStream);
    await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2, info: {name: "mcp-app-client", version: "1.0.0"}, capabilities: {_meta: {lody: {mcpApps: {version: 1}}}},
    });
    return {
        request: (method: string, params: unknown) => connection.agent.request(method, params),
        close: () => connection.close(),
    };
}

describe("MCP Apps", () => {
    it("declares the MCP Apps UI extension to app-server only for hosting clients", async () => {
        const hosting = createAppServerFixture({});
        const plain = createAppServerFixture({});

        const response = await hosting.agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: mcpAppsClient});
        await plain.agent.initialize({protocolVersion: acp.PROTOCOL_VERSION});

        expect(response.agentCapabilities?._meta?.["lody"]).toMatchObject({mcpApps: {version: 1}});
        expect(hosting.requests("initialize")).toEqual([expect.objectContaining({
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
                extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}},
            },
        })]);
        expect(plain.requests("initialize")).toEqual([expect.objectContaining({
            capabilities: {experimentalApi: true, requestAttestation: false},
        })]);
    });

    it("rejects app requests when the client did not negotiate MCP Apps", async () => {
        const {agent} = createAppServerFixture({"thread/read": () => ({thread: threadWith([completedApp])})});
        await openSession(agent, null);

        await expect(agent.mcpAppLoad({sessionId, toolCallId: "call-app-1"}))
            .rejects.toMatchObject({code: -32600});
    });

    it("rejects unknown sessions and tool calls that carry no app", async () => {
        const {agent} = createAppServerFixture({
            "thread/read": () => ({thread: threadWith([appItem({id: "plain", appContext: null, mcpAppUi: null})])}),
        });
        await openSession(agent);

        await expect(agent.mcpAppLoad({sessionId: "missing", toolCallId: "call-app-1"}))
            .rejects.toMatchObject({code: -32602});
        await expect(agent.mcpAppLoad({sessionId, toolCallId: "plain"}))
            .rejects.toMatchObject({code: -32602});
        await expect(agent.mcpAppLoad({sessionId, toolCallId: "unknown"}))
            .rejects.toMatchObject({code: -32602});
    });

    it("emits app metadata on live tool calls and serves them without re-reading history", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const state = await openSession(agent);
        const threadRead = vi.spyOn(fixture.getCodexAppServerClient(), "threadRead");
        const notify = (method: "item/started" | "item/completed", item: AppToolCallItem): ServerNotification => ({
            method,
            params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, completedAtMs: 0, item},
        } as ServerNotification);

        await setupPromptAndSendNotifications(fixture, sessionId, state, [
            notify("item/started", appItem()),
            notify("item/started", appItem({id: "legacy", appContext: {...appItem().appContext!, resourceUri: "app://connector"}, mcpAppUi: null})),
            notify("item/completed", completedApp),
        ]);

        const toolCalls = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.sessionUpdate === "tool_call");
        expect(toolCalls.map(update => [update.toolCallId, update.title, update._meta])).toEqual([
            ["call-app-1", "mcp.codex_apps.explore_graph", {
                is_mcp_tool_call: true,
                lody: {mcpApp: {
                    version: 1, server: "codex_apps", tool: "explore_graph", resourceUri,
                    appName: "Synthetic Graph", preferredDisplayMode: "inline",
                }},
            }],
            ["legacy", "mcp.codex_apps.explore_graph", {is_mcp_tool_call: true}],
        ]);
        await expect(agent.mcpAppLoad({sessionId, toolCallId: "call-app-1"})).resolves.toEqual({
            app: toolCalls[0]._meta.lody.mcpApp,
            toolInput: {query: "synthetic"},
            toolResult: {content: appResult.content, structuredContent: {nodes: 3}},
        });
        expect(threadRead).not.toHaveBeenCalled();
    });

    it("keeps app metadata off live tool calls for clients that do not host apps", async () => {
        const fixture = createCodexMockTestFixture();
        const state = await openSession(fixture.getCodexAcpAgent(), null);

        await setupPromptAndSendNotifications(fixture, sessionId, state, [{
            method: "item/started",
            params: {threadId: sessionId, turnId: "turn-1", startedAtMs: 0, item: appItem()},
        } as ServerNotification]);

        const toolCall = fixture.getAcpConnectionEvents([])
            .map(event => event.args[0]?.update)
            .find(update => update?.sessionUpdate === "tool_call");
        expect(toolCall._meta).toEqual({is_mcp_tool_call: true});
    });

    it("replays app metadata from history only for hosting clients", async () => {
        const replay = async (clientCapabilities?: acp.ClientCapabilities) => {
            const {fixture, agent} = createAppServerFixture({"thread/read": () => ({thread: threadWith([completedApp])})});
            await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION, ...(clientCapabilities ? {clientCapabilities} : {})});
            await agent.readSessionHistory({sessionId});
            return fixture.getAcpConnectionEvents([])
                .map(event => event.args[0]?.update)
                .find(update => update?.sessionUpdate === "tool_call")._meta;
        };

        expect(await replay(mcpAppsClient)).toMatchObject({is_mcp_tool_call: true, lody: {mcpApp: {resourceUri}}});
        expect(await replay()).toEqual({is_mcp_tool_call: true});
    });

    it("loads a call missing from memory by reading the thread", async () => {
        const {agent} = createAppServerFixture({"thread/read": () => ({thread: threadWith([completedApp])})});
        await openSession(agent);

        const loaded = await agent.mcpAppLoad({sessionId, toolCallId: "call-app-1"});

        expect(loaded).toMatchObject({
            app: {server: "codex_apps", tool: "explore_graph", resourceUri},
            toolInput: {query: "synthetic"},
            toolResult: {content: appResult.content},
        });
    });

    it("reads resources pinned to the originating server, thread and call", async () => {
        const contents = [{uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: "<html></html>"}];
        const {agent, requests} = createAppServerFixture({
            "thread/read": () => ({thread: threadWith([completedApp])}),
            "mcpServer/resource/read": () => ({contents, originCallId: "call-app-1"}),
        });
        await openSession(agent);

        await expect(agent.mcpAppResourceRead({sessionId, toolCallId: "call-app-1", uri: resourceUri}))
            .resolves.toEqual({contents});
        expect(requests("mcpServer/resource/read")).toEqual([{
            threadId: sessionId,
            originCallId: "call-app-1",
            server: "codex_apps",
            uri: resourceUri,
            connectorId: "connector-synthetic",
        }]);
    });

    it("maps app-server failures to JSON-RPC errors", async () => {
        const {agent} = createAppServerFixture({
            "thread/read": () => ({thread: threadWith([completedApp])}),
            "mcpServer/resource/read": () => { throw new ResponseError(-32002, "resource not found", {uri: resourceUri}); },
        });
        await openSession(agent);

        const failure = await agent.mcpAppResourceRead({sessionId, toolCallId: "call-app-1", uri: resourceUri})
            .then(() => null, (error: unknown) => error);

        expect(failure).toBeInstanceOf(acp.RequestError);
        expect(failure).toMatchObject({code: -32002, message: "resource not found", data: {uri: resourceUri}});
    });

    it.each([
        {name: "model-only tools", handler: toolServer(["model"])},
        {name: "tools the server does not list", handler: () => ({data: [], nextCursor: null})},
    ])("refuses app tool calls to $name", async ({handler}) => {
        const {agent, requests} = createAppServerFixture({
            "thread/read": () => ({thread: threadWith([completedApp])}),
            "mcpServerStatus/list": handler,
            "mcpServer/tool/call": () => ({content: []}),
        });
        await openSession(agent);

        await expect(agent.mcpAppToolCall({sessionId, toolCallId: "call-app-1", name: "refresh_graph"}))
            .rejects.toMatchObject({code: -32602});
        expect(requests("mcpServer/tool/call")).toEqual([]);
    });

    it.each([
        {name: "app-visible", visibility: ["app"]},
        {name: "undeclared-visibility", visibility: undefined},
    ])("forwards $name tool calls to the originating server", async ({visibility}) => {
        const toolResult = {content: [{type: "text", text: "refreshed"}], structuredContent: {nodes: 4}};
        const {agent, requests} = createAppServerFixture({
            "thread/read": () => ({thread: threadWith([completedApp])}),
            "mcpServerStatus/list": toolServer(visibility),
            "mcpServer/tool/call": () => toolResult,
        });
        await openSession(agent);

        await expect(agent.mcpAppToolCall({
            sessionId, toolCallId: "call-app-1", name: "refresh_graph", arguments: {depth: 2},
        })).resolves.toEqual(toolResult);
        expect(requests("mcpServer/tool/call")).toEqual([{
            threadId: sessionId, server: "codex_apps", tool: "refresh_graph", arguments: {depth: 2},
        }]);
    });

    it.each(["v1", "v2"] as const)("routes the three Lody MCP App methods over ACP %s with validated params", async (version) => {
        const received: unknown[] = [];
        const record = async (params: unknown) => {
            received.push(params);
            return {};
        };
        const mocks = createMockConnections();
        mocks.mockCodexConnection.sendRequest.mockResolvedValue({});
        const router = createAcpAgentRouter((connection) => {
            const agent = new CodexAcpServer(
                connection,
                new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any)),
            );
            vi.spyOn(agent, "mcpAppLoad").mockImplementation(record as never);
            vi.spyOn(agent, "mcpAppResourceRead").mockImplementation(record as never);
            vi.spyOn(agent, "mcpAppToolCall").mockImplementation(record as never);
            return agent;
        });
        const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
        router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
        const clientStream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);
        const {request, close} = await connectAndInitialize(version, clientStream);
        try {
            await request(MCP_APP_LOAD_METHOD, {sessionId, toolCallId: "c"});
            await request(MCP_APP_RESOURCE_READ_METHOD, {sessionId, toolCallId: "c", uri: resourceUri});
            await request(MCP_APP_TOOL_CALL_METHOD, {sessionId, toolCallId: "c", name: "t", arguments: {a: 1}});
            await expect(request(MCP_APP_TOOL_CALL_METHOD, {sessionId, toolCallId: "c"}))
                .rejects.toMatchObject({code: -32602});
        } finally {
            close();
        }

        expect(received).toEqual([
            {sessionId, toolCallId: "c"},
            {sessionId, toolCallId: "c", uri: resourceUri},
            {sessionId, toolCallId: "c", name: "t", arguments: {a: 1}},
        ]);
        // ACP v2 clients negotiate the same `_meta.lody.mcpApps` capability.
        const appServerInitialize = mocks.mockCodexConnection.sendRequest.mock.calls
            .find(([type]: [{method?: string} | string]) => (typeof type === "string" ? type : type.method) === "initialize");
        expect(appServerInitialize?.[1]).toMatchObject({
            capabilities: {extensions: {"io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]}}},
        });
    });
});
