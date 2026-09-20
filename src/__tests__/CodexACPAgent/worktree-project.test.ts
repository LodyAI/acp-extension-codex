import {mkdir, mkdtemp, realpath, rm, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ErrorCodes, ResponseError} from "vscode-jsonrpc/node";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {readWorktreeProject, WorktreeProjects} from "../../WorktreeProject";

describe("local project identity across worktrees", () => {
    let root: string;
    let fixture: ReturnType<typeof createCodexMockTestFixture>;
    beforeEach(async () => {
        root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acp-project-")));
        fixture = createCodexMockTestFixture();
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(native, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(native, "configRead").mockResolvedValue({config: {}} as never);
        vi.spyOn(native, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
        vi.spyOn(native, "threadUnsubscribe").mockResolvedValue({} as never);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, {recursive: true, force: true});
    });

    function metadata(originProjectPath = root) {
        return {lody: {worktreeProject: {version: 1, originProjectPath}}};
    }
    function resumed(projectId: string | null = null) {
        return {
            thread: {id: "thread-1", projectId},
            model: "model-id", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
        };
    }
    function mockProjectCreate(projectId = "adapter-project") {
        return vi.spyOn(fixture.getCodexAppServerClient(), "projectCreate")
            .mockResolvedValue({project: {id: projectId}});
    }
    function deletedProjectError(idempotencyKey: string) {
        return new ResponseError(
            ErrorCodes.InternalError,
            `failed to run project/create: internal state error: idempotency key refers to deleted project: ${idempotencyKey}`,
        );
    }

    it("starts in the worktree with the deterministic native project", async () => {
        const create = mockProjectCreate();
        const native = fixture.getCodexAppServerClient();
        const start = vi.spyOn(native, "threadStart").mockResolvedValue(resumed("adapter-project") as never);
        const cwd = path.join(root, "worktree");
        const result = await fixture.getCodexAcpClient().newSession({cwd, mcpServers: [], _meta: metadata()});
        expect(result.sessionId).toBe("thread-1");
        expect(create).toHaveBeenCalledWith({
            idempotencyKey: expect.stringMatching(/^acp-project-v1:[0-9a-f]{64}$/),
            name: path.basename(root),
            roots: [{path: root}],
        });
        expect(start).toHaveBeenCalledWith({
            cwd, projectId: "adapter-project", modelProvider: null,
            config: {
                features: {cwd_relative_turn_diffs: false},
                projects: {[cwd]: {trust_level: "trusted"}},
            },
        });
    });

    it("gets one native identity for canonical aliases across adapter instances", async () => {
        const native = fixture.getCodexAppServerClient();
        const projects = new Map<string, string>();
        const requests: Array<{idempotencyKey: string; name: string; roots: Array<{path: string}>}> = [];
        vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            requests.push(params);
            let projectId = projects.get(params.idempotencyKey);
            if (!projectId) {
                projectId = `native-project-${projects.size + 1}`;
                projects.set(params.idempotencyKey, projectId);
            }
            return {project: {id: projectId}};
        });
        const alias = path.join(root, "alias");
        await symlink(root, alias, "dir");
        const first = new WorktreeProjects(native);
        const second = new WorktreeProjects(native);
        const ids = await Promise.all([
            first.resolve({version: 1, originProjectPath: root}),
            first.resolve({version: 1, originProjectPath: alias}),
            second.resolve({version: 1, originProjectPath: root}),
        ]);
        expect(ids).toEqual(["native-project-1", "native-project-1", "native-project-1"]);
        expect(new Set(requests.map(request => request.idempotencyKey)).size).toBe(1);
        expect(requests.every(request => request.name === path.basename(root)
            && request.roots[0]?.path === root)).toBe(true);
    });

    it("keeps distinct canonical roots that differ by trailing whitespace separate", async () => {
        const native = fixture.getCodexAppServerClient();
        vi.spyOn(native, "projectCreate").mockImplementation(async params => ({
            project: {id: params.idempotencyKey},
        }));
        const roots = [path.join(root, "source"), path.join(root, "source ")];
        await Promise.all(roots.map(originProjectPath => mkdir(originProjectPath)));
        const resolver = new WorktreeProjects(native);
        const ids = await Promise.all(roots.map(originProjectPath => resolver.resolve({version: 1, originProjectPath})));
        expect(ids[0]).not.toEqual(ids[1]);
    });

    it("ignores user projects that share the canonical root", async () => {
        const native = fixture.getCodexAppServerClient();
        const projectList = vi.fn().mockResolvedValue({data: [
            {id: "user-one", roots: [{path: root}]},
            {id: "user-two", roots: [{path: root}]},
        ], nextCursor: null});
        Object.assign(native, {projectList});
        mockProjectCreate("adapter-owned");
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .resolves.toBe("adapter-owned");
        expect(projectList).not.toHaveBeenCalled();
    });

    it.each(["resumeSession", "loadSession"] as const)("backfills an unassigned persisted thread on %s", async method => {
        const native = fixture.getCodexAppServerClient();
        const create = mockProjectCreate();
        const response = resumed();
        const resume = vi.spyOn(native, "threadResume").mockResolvedValue(response as never);
        vi.spyOn(native, "threadReadWithHistory").mockImplementation(async () => ({thread: response.thread}) as never);
        const update = vi.spyOn(native, "threadProjectUpdate").mockImplementation(async ({projectId}) => {
            response.thread.projectId = projectId;
        });
        const cwd = path.join(root, "worktree");
        await fixture.getCodexAcpClient()[method]({sessionId: "thread-1", cwd, mcpServers: [], _meta: metadata()});
        expect(create).toHaveBeenCalledOnce();
        expect(response.thread.projectId).toBe("adapter-project");
        expect(update).toHaveBeenCalledWith({threadId: "thread-1", projectId: "adapter-project"});
        expect(resume).toHaveBeenCalledWith(expect.objectContaining({cwd}));
    });

    it.each(["resumeSession", "loadSession"] as const)("preserves an existing native assignment on %s", async method => {
        const native = fixture.getCodexAppServerClient();
        const response = resumed("user-selected-project");
        vi.spyOn(native, "threadResume").mockResolvedValue(response as never);
        vi.spyOn(native, "threadReadWithHistory").mockImplementation(async () => ({thread: response.thread}) as never);
        const create = vi.spyOn(native, "projectCreate").mockRejectedValue(new Error("must preserve existing assignment"));
        const update = vi.spyOn(native, "threadProjectUpdate").mockRejectedValue(new Error("must preserve existing assignment"));
        const result = await fixture.getCodexAcpClient()[method]({
            sessionId: "thread-1", cwd: root, mcpServers: [], _meta: metadata(),
        });
        expect(result.sessionId).toBe("thread-1");
        expect(response.thread.projectId).toBe("user-selected-project");
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("preserves the native project inherited by a fork child", async () => {
        const native = fixture.getCodexAppServerClient();
        const response = resumed("inherited-project");
        response.thread.id = "fork-child";
        vi.spyOn(native, "threadFork").mockResolvedValue(response as never);
        const create = vi.spyOn(native, "projectCreate").mockRejectedValue(new Error("must preserve inherited assignment"));
        const update = vi.spyOn(native, "threadProjectUpdate").mockRejectedValue(new Error("must preserve inherited assignment"));
        const result = await fixture.getCodexAcpClient().forkSession({
            sessionId: "source-thread", cwd: path.join(root, "worktree"), mcpServers: [], _meta: metadata(),
        });
        expect(result.sessionId).toBe("fork-child");
        expect(response.thread.projectId).toBe("inherited-project");
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("backfills the deterministic project when a fork child is unassigned", async () => {
        const native = fixture.getCodexAppServerClient();
        const response = resumed();
        response.thread.id = "fork-child";
        vi.spyOn(native, "threadFork").mockResolvedValue(response as never);
        const create = mockProjectCreate();
        const update = vi.spyOn(native, "threadProjectUpdate").mockImplementation(async ({projectId}) => {
            response.thread.projectId = projectId;
        });
        const result = await fixture.getCodexAcpClient().forkSession({
            sessionId: "source-thread", cwd: path.join(root, "worktree"), mcpServers: [], _meta: metadata(),
        });
        expect(result.sessionId).toBe("fork-child");
        expect(create).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledWith({threadId: "fork-child", projectId: "adapter-project"});
    });

    it("reuses the backward-compatible generation-0 project", async () => {
        const native = fixture.getCodexAppServerClient();
        const create = vi.spyOn(native, "projectCreate").mockResolvedValue({project: {id: "generation-zero"}});
        const resolver = new WorktreeProjects(native);
        await expect(resolver.resolve({version: 1, originProjectPath: root})).resolves.toBe("generation-zero");
        await expect(resolver.resolve({version: 1, originProjectPath: root})).resolves.toBe("generation-zero");
        expect(create).toHaveBeenCalledTimes(2);
        const keys = create.mock.calls.map(([params]) => params.idempotencyKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toMatch(/^acp-project-v1:[0-9a-f]{64}$/);
    });

    it("recovers a generation-0 tombstone through generation 1 without root guessing", async () => {
        const native = fixture.getCodexAppServerClient();
        const projectList = vi.fn().mockResolvedValue({data: [{id: "user-project", roots: [{path: root}]}]});
        Object.assign(native, {projectList});
        const create = vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            if (!params.idempotencyKey.endsWith(":g1")) throw deletedProjectError(params.idempotencyKey);
            return {project: {id: "generation-one"}};
        });
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .resolves.toBe("generation-one");
        expect(create.mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
            expect.stringMatching(/^acp-project-v1:[0-9a-f]{64}$/),
            expect.stringMatching(/^acp-project-v1:[0-9a-f]{64}:g1$/),
        ]);
        expect(projectList).not.toHaveBeenCalled();
    });

    it("advances across consecutive tombstones to the first live generation", async () => {
        const native = fixture.getCodexAppServerClient();
        const create = vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            if (!params.idempotencyKey.endsWith(":g3")) throw deletedProjectError(params.idempotencyKey);
            return {project: {id: "generation-three"}};
        });
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .resolves.toBe("generation-three");
        expect(create.mock.calls.map(([params]) => params.idempotencyKey.replace(/^acp-project-v1:[0-9a-f]{64}/, "g0")))
            .toEqual(["g0", "g0:g1", "g0:g2", "g0:g3"]);
    });

    it("converges independent adapters on one recovered native project", async () => {
        const native = fixture.getCodexAppServerClient();
        const projects = new Map<string, string>();
        const create = vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            if (!params.idempotencyKey.endsWith(":g1")) throw deletedProjectError(params.idempotencyKey);
            let projectId = projects.get(params.idempotencyKey);
            if (!projectId) {
                projectId = "shared-generation-one";
                projects.set(params.idempotencyKey, projectId);
            }
            return {project: {id: projectId}};
        });
        const ids = await Promise.all([
            new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}),
            new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}),
        ]);
        expect(ids).toEqual(["shared-generation-one", "shared-generation-one"]);
        expect(projects.size).toBe(1);
        expect(create).toHaveBeenCalledTimes(4);
    });

    it("finds the same current generation after resolver restart without a cache", async () => {
        const native = fixture.getCodexAppServerClient();
        const create = vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            if (!params.idempotencyKey.endsWith(":g1")) throw deletedProjectError(params.idempotencyKey);
            return {project: {id: "current-generation"}};
        });
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .resolves.toBe("current-generation");
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .resolves.toBe("current-generation");
        expect(create.mock.calls.map(([params]) => params.idempotencyKey.endsWith(":g1") ? "g1" : "g0"))
            .toEqual(["g0", "g1", "g0", "g1"]);
    });

    it("propagates unrelated project creation failures without advancing", async () => {
        const native = fixture.getCodexAppServerClient();
        const error = new ResponseError(ErrorCodes.InternalError, "failed to run project/create: disk is full");
        const create = vi.spyOn(native, "projectCreate").mockRejectedValue(error);
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .rejects.toBe(error);
        expect(create).toHaveBeenCalledOnce();
    });

    it("does not treat an untyped lookalike failure as a Codex tombstone", async () => {
        const native = fixture.getCodexAppServerClient();
        const error = new Error("idempotency key refers to deleted project");
        const create = vi.spyOn(native, "projectCreate").mockRejectedValue(error);
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .rejects.toBe(error);
        expect(create).toHaveBeenCalledOnce();
    });

    it("fails clearly after exhausting the bounded generation sequence", async () => {
        const native = fixture.getCodexAppServerClient();
        const create = vi.spyOn(native, "projectCreate").mockImplementation(async params => {
            throw deletedProjectError(params.idempotencyKey);
        });
        await expect(new WorktreeProjects(native).resolve({version: 1, originProjectPath: root}))
            .rejects.toThrow("Codex project recovery exhausted generations 0 through 32");
        expect(create).toHaveBeenCalledTimes(33);
    });

    it("leaves clients without project metadata unchanged", async () => {
        const native = fixture.getCodexAppServerClient();
        const create = vi.spyOn(native, "projectCreate").mockRejectedValue(new Error("unexpected project creation"));
        const start = vi.spyOn(native, "threadStart").mockResolvedValue(resumed() as never);
        await fixture.getCodexAcpClient().newSession({cwd: root, mcpServers: []});
        expect(create).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledWith({
            cwd: root, modelProvider: null,
            config: {
                features: {cwd_relative_turn_diffs: false},
                projects: {[root]: {trust_level: "trusted"}},
            },
        });
    });

    it.each([null, {version: 2, originProjectPath: "/project"}, {version: 1, originProjectPath: "relative"}])("rejects invalid project metadata %j", value => {
        expect(() => readWorktreeProject({lody: {worktreeProject: value}})).toThrow("absolute originProjectPath");
    });
});
