import {afterEach, describe, expect, it, vi} from "vitest";
import {TitleGenerator} from "../TitleGenerator";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}

function createGenerator(client: Partial<CodexAppServerClient>) {
    return new TitleGenerator(client as CodexAppServerClient, "thread-id", "/test/cwd", () => "unset");
}

describe("TitleGenerator.waitForIdle", () => {
    it("returns immediately when nothing is generating", async () => {
        const generator = createGenerator({});

        await expect(generator.waitForIdle(50)).resolves.toBeUndefined();
    });

    it("waits for the rename echo notification before settling", async () => {
        const turn = deferred<{turn: {status: string; error: null; items: {type: string; text: string}[]}}>();
        const threadSetName = vi.fn().mockResolvedValue({});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(turn.promise),
            threadSetName,
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");
        let settled = false;
        const idle = generator.waitForIdle(5_000).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        turn.resolve({turn: {status: "completed", error: null, items: [{type: "agentMessage", text: '{"title":"A short title"}'}]}});
        // Flush the microtask chain (extract title -> threadSetName -> start
        // waiting for the echo) without resolving the echo itself yet.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(threadSetName).toHaveBeenCalledWith({threadId: "thread-id", name: "A short title"});
        expect(settled).toBe(false);

        // The thread/name/updated notification for this rename arrives.
        generator.observeRename();
        await idle;
        expect(settled).toBe(true);
    });

    it("gives up after the timeout rather than holding the caller open", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn: vi.fn().mockReturnValue(new Promise(() => {})),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(20)).resolves.toBeUndefined();
    });

    it("stops waiting once a failed generation has settled", async () => {
        const generator = createGenerator({
            threadStart: vi.fn().mockRejectedValue(new Error("no ephemeral threads")),
            runTurn: vi.fn(),
            threadSetName: vi.fn(),
        } as unknown as Partial<CodexAppServerClient>);

        generator.onTurnCompleted("hello");

        await expect(generator.waitForIdle(5_000)).resolves.toBeUndefined();
    });
});

describe("TitleGenerator prompt", () => {
    it("sends only the start of a long first message to the title model", async () => {
        const runTurn = vi.fn().mockResolvedValue({turn: {status: "completed", error: null, items: []}});
        const generator = createGenerator({
            threadStart: vi.fn().mockResolvedValue({thread: {id: "ephemeral"}}),
            runTurn,
        } as unknown as Partial<CodexAppServerClient>);

        // The cut falls between the two halves of the emoji.
        generator.onTurnCompleted(`${"a".repeat(3_999)}\u{1F600}${"b".repeat(200_000)}`);
        await generator.waitForIdle(1_000);

        const text: string = runTurn.mock.calls[0]![0].input[0].text;
        expect(text.endsWith(`User's first message:\n${"a".repeat(3_999)}`)).toBe(true);
    });
});

describe("TitleGenerator failure diagnostics", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it.each(["file", "stderr"])("preserves native failure details in %s without publishing a title", async sink => {
        const directory = mkdtempSync(join(tmpdir(), "codex-title-"));
        vi.stubEnv("APP_SERVER_LOGS", sink === "file" ? directory : "");
        vi.resetModules();
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const stdout = vi.spyOn(process.stdout, "write");
        const {TitleGenerator: Generator} = await import("../TitleGenerator");
        const nativeError = {
            message: "unexpected status 422: synthetic unavailable model",
            codexErrorInfo: {httpConnectionFailed: {httpStatusCode: 422}},
            additionalDetails: "synthetic provider detail",
            misalignment: null,
        };
        let title: string | undefined;
        const generator = new Generator({
            threadStart: async () => ({thread: {id: "title-thread"}}),
            runTurn: async () => ({turn: {
                id: "title-turn", status: "failed", error: nativeError,
                items: [{type: "agentMessage", text: '{"title":"Do not publish"}'}],
            }}),
            threadSetName: async (params: {name: string}) => { title = params.name; },
        } as unknown as CodexAppServerClient, "main-thread", "/test", () => "unset");
        try {
            generator.onTurnCompleted("private source message");
            await expect(generator.waitForIdle(1_000)).resolves.toBeUndefined();
            const output = sink === "file"
                ? readFileSync(join(directory, "app-server.log"), "utf8")
                : stderr.mock.calls.map(args => args.join(" ")).join("\n");
            const diagnostic = sink === "file"
                ? JSON.parse(output.slice(output.indexOf(" {", output.indexOf("Title generation turn failed")) + 1).trim()).exception
                : output;
            expect(diagnostic).toContain(JSON.stringify(nativeError));
            expect(output).toContain("titleThreadId=title-thread");
            expect(output).toContain("turnId=title-turn");
            expect(output).toContain("mainThreadId=main-thread");
            expect(output).toContain("model=gpt-5.6-luna");
            expect(output).not.toContain("private source message");
            expect(title).toBeUndefined();
            expect(stdout).not.toHaveBeenCalled();
        } finally {
            rmSync(directory, {recursive: true, force: true});
        }
    });

    it.each(["exception", "invalid output"])("logs %s and settles the background task", async failure => {
        vi.stubEnv("APP_SERVER_LOGS", "");
        vi.resetModules();
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const {TitleGenerator: Generator} = await import("../TitleGenerator");
        let title: string | undefined;
        const generator = new Generator({
            threadStart: async () => {
                if (failure === "exception") throw new Error("synthetic thread start failure");
                return {thread: {id: "title-thread"}};
            },
            runTurn: async () => ({turn: {id: "title-turn", status: "completed", error: null, items: []}}),
            threadSetName: async (params: {name: string}) => { title = params.name; },
        } as unknown as CodexAppServerClient, "main-thread", "/test", () => "unset");
        generator.onTurnCompleted("private source message");
        await expect(generator.waitForIdle(1_000)).resolves.toBeUndefined();
        const output = stderr.mock.calls.map(args => args.join(" ")).join("\n");
        expect(output).toContain(failure === "exception" ? "synthetic thread start failure" : "Missing or malformed title JSON");
        expect(title).toBeUndefined();
    });
});
