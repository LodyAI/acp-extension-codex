import * as acp from "@agentclientprotocol/sdk/unstable";
import {describe, expect, it} from "vitest";
import {GOAL_CONTROL_METHOD} from "../AcpExtensions";
import type {CodexAcpServer} from "../CodexAcpServer";
import {createCodexAcpApp} from "../CodexAcpApp";

describe("goal control transport", () => {
    it("routes the Lody goal method over an ACP connection", async () => {
            const method = GOAL_CONTROL_METHOD;
            let connectionInstalled = false;
            const app = createCodexAcpApp({
                name: "goal-control-test",
                createAgent() {
                    connectionInstalled = true;
                    return {
                        async initialize() {
                            return {protocolVersion: 1, agentCapabilities: {}, authMethods: []};
                        },
                        async extMethod(receivedMethod: string, params: Record<string, unknown>) {
                            return {receivedMethod, params};
                        },
                    } as unknown as CodexAcpServer;
                },
            });

            const response = await acp.client({name: "goal-control-client"}).connectWith(app, async (connection) => {
                await connection.request(acp.methods.agent.initialize, {protocolVersion: 1, clientCapabilities: {}});
                return connection.request(method, {
                    sessionId: "session-1",
                    action: "set",
                    objective: "Ship the sync",
                });
            });

            expect(connectionInstalled).toBe(true);
            expect(response).toEqual({
                receivedMethod: method,
                params: {
                    sessionId: "session-1",
                    action: "set",
                    objective: "Ship the sync",
                },
            });
        });
});
