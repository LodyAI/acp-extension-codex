import {RequestError} from "@agentclientprotocol/sdk";
import {
    LODY_EXTENSION_METHODS,
    type LodyMcpAppLoadResponse,
    type LodyMcpAppResourceReadResponse,
    type LodyMcpAppToolCallMeta,
    type LodyMcpAppToolCallResponse,
    type LodyMcpCallToolResult,
    type LodyMcpResourceContents,
} from "acp-extension-core";
import {ResponseError} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Tool} from "./app-server/Tool";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {McpToolCallResult, McpToolCallStatus, ThreadItem} from "./app-server/v2";

export const MCP_APP_LOAD_METHOD = LODY_EXTENSION_METHODS.mcpAppsLoad;
export const MCP_APP_RESOURCE_READ_METHOD = LODY_EXTENSION_METHODS.mcpAppsResourceRead;
export const MCP_APP_TOOL_CALL_METHOD = LODY_EXTENSION_METHODS.mcpAppsToolCall;

/**
 * App-server `initialize` extensions for hosts that render MCP Apps. Codex forwards
 * them to MCP servers; spec-following servers omit UI resources without them.
 */
export const MCP_APPS_APP_SERVER_EXTENSIONS = {
    "io.modelcontextprotocol/ui": {mimeTypes: ["text/html;profile=mcp-app"]},
};

type McpToolCallItem = Extract<ThreadItem, {type: "mcpToolCall"}>;
type AppServer = Pick<
    CodexAppServerClient,
    "threadReadWithHistory" | "listMcpServerStatus" | "mcpResourceRead" | "mcpServerToolCall"
>;

type McpAppCall = {
    threadId: string;
    itemId: string;
    app: LodyMcpAppToolCallMeta;
    connectorId: string | null;
    arguments: unknown;
    result: McpToolCallResult | null;
    status: McpToolCallStatus;
};

export function clientSupportsMcpApps(capabilities: unknown): boolean {
    const lody = field(field(capabilities, "_meta"), "lody");
    return field(field(lody, "mcpApps"), "version") === 1;
}

export function readMcpAppMeta(item: McpToolCallItem): LodyMcpAppToolCallMeta | null {
    // `mcpAppUi` is absent in history written before Codex captured it.
    const ui = item.mcpAppUi ?? null;
    const resourceUri = [ui?.resourceUri, item.appContext?.resourceUri, item.mcpAppResourceUri]
        .find((uri): uri is string => typeof uri === "string" && uri.startsWith("ui://"));
    if (resourceUri === undefined) return null;
    const app: LodyMcpAppToolCallMeta = {version: 1, server: item.server, tool: item.tool, resourceUri};
    if (item.appContext?.appName) app.appName = item.appContext.appName;
    const mode = ui?.preferredModelDisplayMode;
    if (mode === "inline" || mode === "fullscreen") app.preferredDisplayMode = mode;
    return app;
}

/**
 * Per-session record of tool calls that opened an MCP App, keyed by ACP `toolCallId`
 * (which is the Codex item id). App requests are always pinned to the originating
 * call's thread and server.
 */
export class McpAppCalls {
    private readonly calls = new Map<string, McpAppCall>();
    private readonly tools = new Map<string, Tool[]>();

    /** Records an app-bearing item and returns the metadata to attach to its tool call. */
    track(threadId: string, item: McpToolCallItem): LodyMcpAppToolCallMeta | null {
        const app = readMcpAppMeta(item) ?? this.calls.get(item.id)?.app ?? null;
        if (app === null) return null;
        this.calls.set(item.id, {
            threadId,
            itemId: item.id,
            app,
            connectorId: item.appContext?.connectorId ?? null,
            arguments: item.arguments,
            result: item.result,
            status: item.status,
        });
        return app;
    }

    async load(appServer: AppServer, sessionId: string, toolCallId: string): Promise<LodyMcpAppLoadResponse> {
        const call = await this.require(appServer, sessionId, toolCallId);
        const toolInput = isRecord(call.arguments) ? call.arguments : {};
        return {app: call.app, toolInput, toolResult: toCallToolResult(call.result, call.status)};
    }

    async readResource(
        appServer: AppServer,
        sessionId: string,
        toolCallId: string,
        uri: string,
    ): Promise<LodyMcpAppResourceReadResponse> {
        const call = await this.require(appServer, sessionId, toolCallId);
        const response = await forwardErrors(() => appServer.mcpResourceRead({
            threadId: call.threadId,
            originCallId: call.itemId,
            server: call.app.server,
            uri,
            connectorId: call.connectorId,
        }));
        return {contents: response.contents as LodyMcpResourceContents[]};
    }

    async callTool(
        appServer: AppServer,
        sessionId: string,
        toolCallId: string,
        name: string,
        args: Record<string, unknown> | undefined,
    ): Promise<LodyMcpAppToolCallResponse> {
        const call = await this.require(appServer, sessionId, toolCallId);
        const server = call.app.server;
        const tool = await this.findTool(appServer, call.threadId, server, name);
        const visibility = field(field(tool?._meta, "ui"), "visibility");
        if (tool === undefined || (Array.isArray(visibility) && !visibility.includes("app"))) {
            throw RequestError.invalidParams(undefined, `Tool ${name} on ${server} is not callable from its MCP App`);
        }
        return await forwardErrors(() => appServer.mcpServerToolCall({
            threadId: call.threadId,
            server,
            tool: name,
            ...(args !== undefined ? {arguments: args as JsonValue} : {}),
        })) as LodyMcpAppToolCallResponse;
    }

    private async require(appServer: AppServer, sessionId: string, toolCallId: string): Promise<McpAppCall> {
        const known = this.calls.get(toolCallId);
        if (known) return known;
        // Calls from before an adapter restart or a history-only replay are not in memory.
        const {thread} = await forwardErrors(() => appServer.threadReadWithHistory(sessionId));
        for (const item of thread.turns.flatMap(turn => turn.items)) {
            if (item.type === "mcpToolCall") this.track(thread.id, item);
        }
        const call = this.calls.get(toolCallId);
        if (!call) {
            throw RequestError.invalidParams(undefined, `Unknown MCP App tool call: ${toolCallId}`);
        }
        return call;
    }

    /** A cache miss re-lists the server once, so tools added after the first lookup are found. */
    private async findTool(appServer: AppServer, threadId: string, server: string, name: string): Promise<Tool | undefined> {
        const cached = this.tools.get(server)?.find(tool => tool.name === name);
        if (cached) return cached;
        const tools = await this.listServerTools(appServer, threadId, server);
        this.tools.set(server, tools);
        return tools.find(tool => tool.name === name);
    }

    private async listServerTools(appServer: AppServer, threadId: string, server: string): Promise<Tool[]> {
        let cursor: string | null = null;
        do {
            const page = await forwardErrors(() => appServer.listMcpServerStatus({
                threadId,
                cursor,
                detail: "toolsAndAuthOnly",
            }));
            const status = page.data.find(entry => entry.name === server);
            if (status) return Object.values(status.tools).filter((tool): tool is Tool => tool !== undefined);
            cursor = page.nextCursor;
        } while (cursor !== null);
        return [];
    }
}

function toCallToolResult(result: McpToolCallResult | null, status: McpToolCallStatus): LodyMcpCallToolResult | null {
    if (result === null) return null;
    const converted: LodyMcpCallToolResult = {content: result.content};
    if (isRecord(result.structuredContent)) converted.structuredContent = result.structuredContent;
    if (isRecord(result._meta)) converted._meta = result._meta;
    if (status === "failed") converted.isError = true;
    return converted;
}

/** App-server JSON-RPC failures keep their code and data; the SDK would flatten raw errors. */
async function forwardErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ResponseError) throw new RequestError(error.code, error.message, error.data);
        throw error;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}
