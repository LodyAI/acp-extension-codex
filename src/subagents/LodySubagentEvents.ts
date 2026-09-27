import * as acp from "@agentclientprotocol/sdk";
import {randomUUID} from "node:crypto";
import {LODY_SUBAGENT_EVENT_METHOD, isLodySubagentOutput, type LodySubagentEvent, type LodySubagentSnapshot} from "acp-extension-core";
import type {AcpClientConnection, UpdateSessionEvent} from "../ACPSessionConnection";

/** Translates the native child-session transport only after bilateral negotiation. */
export class LodySubagentEvents {
    private readonly runs = new Map<string, {id: string; snapshot: LodySubagentSnapshot}>();
    private readonly permissionTools = new Map<string, Set<string>>();
    constructor(private readonly root: string, private readonly connection: AcpClientConnection) {}

    private async emit(event: LodySubagentEvent): Promise<void> {
        await this.connection.notify(LODY_SUBAGENT_EVENT_METHOD, event);
    }

    async metadata(sessionId: string, metadata: Partial<Pick<LodySubagentSnapshot, "name" | "description" | "modelId" | "summary" | "parentToolCallId">>): Promise<void> {
        const run = this.runs.get(sessionId);
        if (!run || !Object.entries(metadata).some(([key, value]) => run.snapshot[key as keyof LodySubagentSnapshot] !== value)) return;
        run.snapshot = {...run.snapshot, ...metadata};
        await this.emit({version: 1, sessionId: this.root, runId: run.id, type: "snapshot", snapshot: run.snapshot});
    }

    async update(update: UpdateSessionEvent, sessionId: string): Promise<void> {
        if (update.sessionUpdate === "subagent_spawned") {
            const parent = this.runs.get(sessionId);
            // A missing parent is unknown lineage, never an implicit root edge.
            const snapshot: LodySubagentSnapshot = {
                state: "running",
                ...(sessionId === this.root ? {parentRunId: null} : parent ? {parentRunId: parent.id} : {}),
                name: update.name,
                description: update.task,
                support: {stream: ["text", "thought", "tool", "plan"], progress: false, outputRead: "none", cancel: false},
            };
            const meta = update._meta?.['lody'] as Record<string, unknown> | undefined;
            if (meta?.['initialState'] === 'completed' || meta?.['initialState'] === 'failed' || meta?.['initialState'] === 'cancelled') {
                snapshot.state = meta['initialState'];
            }
            if (meta?.['initialState'] === 'disconnected') {
                snapshot.state = 'unknown';
                snapshot.outputIncomplete = true;
            }
            if (typeof meta?.['parentToolCallId'] === "string") snapshot.parentToolCallId = meta['parentToolCallId'];
            if (meta?.['outputIncomplete'] === true) snapshot.outputIncomplete = true;
            const run = {id: randomUUID(), snapshot};
            this.runs.set(update.subagentSessionId, run);
            this.permissionTools.delete(update.subagentSessionId);
            await this.emit({version: 1, sessionId: this.root, runId: run.id, type: "snapshot", snapshot});
            return;
        }
        if (update.sessionUpdate === "subagent_state_update") {
            const run = this.runs.get(update.subagentSessionId);
            if (!run) return;
            const meta = update._meta?.['lody'] as Record<string, unknown> | undefined;
            run.snapshot = {...run.snapshot, state: update.state === "disconnected" ? "unknown" : update.state,
                ...(update.state === "disconnected" ? {outputIncomplete: true, reason: {code: meta?.['reasonCode'] === 'timeout' ? 'timeout' : "disconnected"}} : {})};
            await this.emit({version: 1, sessionId: this.root, runId: run.id, type: "snapshot", snapshot: run.snapshot});
            return;
        }
        if (sessionId === this.root) {
            await this.connection.notify(acp.methods.client.session.update, {sessionId, update} as acp.SessionNotification);
            return;
        }
        const run = this.runs.get(sessionId);
        if (!run || ["completed", "failed", "cancelled"].includes(run.snapshot.state)) return;
        if (!isLodySubagentOutput(update)) return;
        const lody = update._meta?.['lody'] as Record<string, unknown> | undefined;
        await this.emit({version: 1, sessionId: this.root, runId: run.id, type: "output", update,
            ...(typeof lody?.['turnId'] === "string" ? {nativeTurnId: lody['turnId']} : {}),
            ...('messageId' in update && typeof update.messageId === 'string' ? {messageId: update.messageId} : {})});
        if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
            && this.permissionTools.get(sessionId)?.has(update.toolCallId)) {
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId: this.root,
                update: {...update, toolCallId: this.toolId(run.id, update.toolCallId),
                    _meta: {...update._meta, lody: {...lody, subagentRunId: run.id}}},
            });
        }
    }

    wrap(connection: AcpClientConnection): AcpClientConnection {
        return {
            notify: (async (method: string, params: Record<string, unknown>) => {
                if (method === acp.methods.client.session.update && typeof params['sessionId'] === "string") {
                    await this.update(params['update'] as UpdateSessionEvent, params['sessionId']);
                    return;
                }
                await connection.notify(method, params);
            }) as AcpClientConnection["notify"],
            request: (async (method: string, params: Record<string, unknown>, options: unknown) => {
                const sessionId = params['sessionId'];
                if (typeof sessionId !== "string" || sessionId === this.root) {
                    return await connection.request(method, params, options as never);
                }
                const run = this.runs.get(sessionId);
                if (!run || run.snapshot.state !== "running") throw new Error("Unknown or inactive subagent interaction");
                const meta = params['_meta'] as Record<string, unknown> | undefined;
                const toolCall = params['toolCall'] as acp.ToolCall | undefined;
                const nativeToolCallId = toolCall?.toolCallId ?? (typeof params['toolCallId'] === 'string' ? params['toolCallId'] : undefined);
                if (nativeToolCallId) {
                    const tools = this.permissionTools.get(sessionId) ?? new Set<string>();
                    tools.add(nativeToolCallId);
                    this.permissionTools.set(sessionId, tools);
                }
                return await connection.request(method, {
                    ...params, sessionId: this.root,
                    ...(toolCall ? {toolCall: {...toolCall, toolCallId: this.toolId(run.id, toolCall.toolCallId)}} : {}),
                    ...(typeof params['toolCallId'] === 'string' ? {toolCallId: this.toolId(run.id, params['toolCallId'])} : {}),
                    _meta: {...meta, lody: {...meta?.['lody'] as object, subagentRunId: run.id,
                        ...(nativeToolCallId ? {subagentToolCallId: nativeToolCallId} : {})}},
                }, options as never);
            }) as AcpClientConnection["request"],
        };
    }

    private toolId(runId: string, nativeId: string): string {
        return `subagent:${encodeURIComponent(runId)}:${encodeURIComponent(nativeId)}`;
    }
}
