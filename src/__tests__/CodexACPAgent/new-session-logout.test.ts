import {describe, expect, it, vi} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import {ModelId} from "../../ModelId";

describe("New session logout handling", () => {
    it.each([
        {name: "token refresh", error: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", expected: "Its saved credentials were kept"},
        {name: "cloud requirements", error: "Failed to load cloud requirements (workspace-managed policies).", expected: "cloud requirements"},
    ])("preserves a managed ChatGPT profile on $name failure", async ({name, error, expected}) => {
        const fixture = createCodexMockTestFixture(undefined, undefined, true);
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(error));

        const failure = await codexAcpAgent.newSession({cwd: "", mcpServers: []})
            .then(() => undefined, reason => reason);
        expect(typeof failure?.data === "string" ? failure.data : JSON.stringify(failure?.data ?? failure.message)).toContain(expected);
        if (name === "token refresh") {
            expect(failure?.data).toMatchObject({kind: "codex_refresh_contention"});
        }
        expect(logoutSpy).not.toHaveBeenCalled();
    });

    it("does not mark other refresh failures as contention", async () => {
        const fixture = createCodexMockTestFixture(undefined, undefined, true);
        const codexAcpAgent = fixture.getCodexAcpAgent();
        vi.spyOn(fixture.getCodexAcpClient(), "authRequired").mockResolvedValue(false);
        vi.spyOn(fixture.getCodexAppServerClient(), "threadStart").mockRejectedValue(
            new Error("Your access token could not be refreshed because the account was revoked. Please log out and sign in again.")
        );

        const failure = await codexAcpAgent.newSession({cwd: "", mcpServers: []})
            .then(() => undefined, reason => reason);
        expect(failure?.data).toEqual(expect.any(String));
    });

    it("logs out when newSession fails with an error containing log out", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);

        const errorMessage = `Internal error: "failed to reload config: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`;
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });
        expect(logoutSpy).toHaveBeenCalledOnce();
    });

    it("recovers when newSession fails with a failed to reload config error", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);

        const errorMessage = `Internal error: "failed to reload config: Failed to load cloud requirements (workspace-managed policies)."`;
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });
        expect(logoutSpy).toHaveBeenCalledOnce();
    });

    it("includes the global config path in reload configuration errors", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const errorMessage = 'Internal error: "failed to reload config: filesystem path `/tmp` must be absolute, use `~/...`, or start with `:`"';
        vi.spyOn(codexAppServerClient, "threadStart").mockRejectedValue(new Error(errorMessage));

        expect(logoutSpy).toHaveBeenCalledTimes(0);
        await expect(codexAcpAgent.newSession({cwd: "", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining(`Check global and project .codex directories`),
            });
    });

    it("refreshes OpenAI sessions when newSession error forces logout", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel();
        const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const getAccountSpy = vi.spyOn(codexAcpClient, "getAccount")
            .mockResolvedValueOnce({
                account: { type: "apiKey" },
                requiresOpenaiAuth: false,
            })
            .mockResolvedValueOnce({
                account: null,
                requiresOpenaiAuth: true,
            });

        const errorMessage = `Internal error: "failed to reload config: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."`;
        vi.spyOn(codexAcpClient, "newSession")
            .mockResolvedValueOnce({
                sessionId: "openai-session",
                currentModelId,
                models: [model],
                collaborationMode: "default",
                modelProvider: "openai",
                additionalDirectories: [],
            })
            .mockResolvedValueOnce({
                sessionId: "custom-provider-session",
                currentModelId,
                models: [model],
                collaborationMode: "default",
                modelProvider: "custom-provider",
                additionalDirectories: [],
            })
            .mockRejectedValueOnce(new Error(errorMessage));
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();

        const openAiSession = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});
        const customProviderSession = await codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []});

        await expect(codexAcpAgent.newSession({cwd: "/workspace", mcpServers: []}))
            .rejects.toMatchObject({
                data: expect.stringContaining("You have been logged out. Please try again."),
            });

        expect(logoutSpy).toHaveBeenCalledOnce();
        expect(getAccountSpy).toHaveBeenCalledTimes(2);
        expect(codexAcpAgent.getSessionState(openAiSession.sessionId)).toMatchObject({
            account: null,
            authConfigured: false,
        });
        expect(codexAcpAgent.getSessionState(customProviderSession.sessionId)).toMatchObject({
            account: null,
            authConfigured: true,
            authProvider: "custom-provider",
        });
    });
});

describe("Session open failure diagnostics", () => {
    it.each([
        "workspace routing discovery failed",
        "workspace routing discovery timed out",
    ])("keeps the app-server text and adds a network hint on newSession: %s", async (routingText) => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();
        vi.spyOn(fixture.getCodexAppServerClient(), "threadStart")
            .mockRejectedValue(new ResponseError(-32603, routingText));

        const failure = await agent.newSession({cwd: "/workspace", mcpServers: []})
            .then(() => undefined, reason => reason);

        // A transport failure is not authentication evidence: never authRequired,
        // never a forced logout.
        expect(failure).toMatchObject({code: -32603});
        expect(failure.code).not.toBe(-32000);
        expect(failure.data).toMatchObject({kind: "codex_workspace_routing"});
        expect(failure.data.message).toContain(routingText);
        expect(failure.data.message).toMatch(/network|proxy/i);
        expect(logoutSpy).not.toHaveBeenCalled();
    });

    it.each<{
        name: string;
        open: (agent: CodexAcpServer) => Promise<unknown>;
        appServerMethod: "threadStart" | "threadResume" | "threadFork";
    }>([
        {
            name: "resumeSession",
            appServerMethod: "threadResume",
            open: agent => agent.resumeSession({sessionId: "existing", cwd: "/workspace", mcpServers: []}),
        },
        {
            name: "forkSession",
            appServerMethod: "threadFork",
            open: agent => agent.forkSession({sessionId: "source-id", cwd: "/workspace", mcpServers: []}),
        },
        {
            name: "legacy loadSession",
            appServerMethod: "threadResume",
            open: agent => agent.loadSession({sessionId: "existing", cwd: "/workspace", mcpServers: []}),
        },
        {
            name: "v2 resume with replayFrom start",
            appServerMethod: "threadResume",
            open: agent => agent.resumeSessionV2({sessionId: "existing", cwd: "/workspace", mcpServers: [], replayFrom: {type: "start"}}),
        },
    ])("maps a workspace routing timeout with the same hint on $name", async ({open, appServerMethod}) => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const logoutSpy = vi.spyOn(codexAcpClient, "logout").mockResolvedValue();
        vi.spyOn(fixture.getCodexAppServerClient(), appServerMethod)
            .mockRejectedValue(new ResponseError(-32603, "workspace routing discovery timed out"));

        const failure = await open(agent).then(() => undefined, reason => reason);

        expect(failure).toMatchObject({code: -32603});
        expect(failure.code).not.toBe(-32000);
        expect(failure.data).toMatchObject({kind: "codex_workspace_routing"});
        expect(failure.data.message).toContain("workspace routing discovery timed out");
        expect(failure.data.message).toMatch(/network|proxy/i);
        expect(logoutSpy).not.toHaveBeenCalled();
    });

    it("passes unrelated session-open failures through untouched", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        const nativeError = new ResponseError(-32603, "thread storage is corrupted");
        vi.spyOn(fixture.getCodexAppServerClient(), "threadStart").mockRejectedValue(nativeError);

        await expect(agent.newSession({cwd: "/workspace", mcpServers: []})).rejects.toBe(nativeError);
    });
});
