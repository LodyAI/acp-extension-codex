import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {describe, expect, it} from "vitest";
import {CODEX_LODY_CAPABILITIES, LODY_RATE_LIMITS_GET_METHOD, LODY_READ_SESSION_HISTORY_METHOD} from "../AcpExtensions";
import type {CodexAcpServer} from "../CodexAcpServer";
import {createAcpAgentRouter} from "../AcpAgentRouter";
import {ACPSessionConnection, AcpV2Connection} from "../ACPSessionConnection";

async function connectRouter(version: 1 | 2) {
    const router = createAcpAgentRouter(connection => ({
        async initialize() {
            return {protocolVersion: 1, agentCapabilities: {_meta: {lody: CODEX_LODY_CAPABILITIES}}, authMethods: []};
        },
        async initializeV2() {
            return {protocolVersion: 2, info: {name: "history-test", version: "1"}, capabilities: {_meta: {lody: CODEX_LODY_CAPABILITIES}}};
        },
        async readSessionHistory({sessionId}: {sessionId: string}) {
            if (sessionId === "missing") throw acp.RequestError.invalidParams("History not found");
            const session = new ACPSessionConnection(connection instanceof AcpV2Connection ? connection.extensionOnlyV1View() : connection, sessionId);
            await session.update({sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Imported answer"}});
            return {};
        },
        async readRateLimits() {
            return {accounts: [{accountId: "synthetic", windows: []}]};
        },
        sessionIndex: {dispose() {}},
    }) as unknown as CodexAcpServer);
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
    const updates: unknown[] = [];
    const stream = acp.ndJsonStream(clientToAgent.writable, agentToClient.readable);
    if (version === 1) {
        const client = acp.client({name: "history-test"})
            .onNotification(acp.methods.client.session.update, ctx => { updates.push(ctx.params); })
            .connect(stream);
        const initialized = await client.agent.request(acp.methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {}});
        return {close: () => client.close(), request: (method: string, params: unknown) => client.agent.request(method, params), updates, capabilities: initialized.agentCapabilities};
    }
    const client = acpV2.client({name: "history-test"})
        .onNotification(acpV2.methods.client.session.update, ctx => { updates.push(ctx.params); })
        .connect(stream);
    const initialized = await client.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2, info: {name: "history-test", version: "1"}, capabilities: {},
    });
    return {close: () => client.close(), request: (method: string, params: unknown) => client.agent.request(method, params), updates, capabilities: initialized.capabilities};
}

describe.each([1, 2] as const)("Core history transport over production ACP v%s", version => {
    it("delivers history before the response and serves the advertised rate-limit query", async () => {
        const {close, request, updates, capabilities} = await connectRouter(version);
        try {
            expect(capabilities?._meta).toMatchObject({lody: {
                sessionHistory: {version: 1}, rateLimits: {version: 1, query: true},
            }});
            await expect(request(LODY_READ_SESSION_HISTORY_METHOD, {sessionId: "session-1"})).resolves.toEqual({});
            expect(updates).toHaveLength(1);
            expect(updates[0]).toMatchObject({sessionId: "session-1", update: {content: {type: "text", text: "Imported answer"}}});
            await expect(request(LODY_RATE_LIMITS_GET_METHOD, {})).resolves.toEqual({
                accounts: [{accountId: "synthetic", windows: []}],
            });
        } finally {
            close();
        }
    });

    it("rejects invalid parameters and preserves history errors without replay", async () => {
        const {close, request, updates} = await connectRouter(version);
        try {
            for (const params of [{}, {sessionId: ""}, {sessionId: 42}]) {
                await expect(request(LODY_READ_SESSION_HISTORY_METHOD, params)).rejects.toMatchObject({code: -32602});
            }
            await expect(request(LODY_RATE_LIMITS_GET_METHOD, {accountId: 42})).rejects.toMatchObject({code: -32602});
            await expect(request(LODY_READ_SESSION_HISTORY_METHOD, {sessionId: "missing"})).rejects.toMatchObject({code: -32602, data: "History not found"});
            expect(updates).toEqual([]);
        } finally {
            close();
        }
    });
});
