import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import path from "node:path";
import {RequestError} from "@agentclientprotocol/sdk";
import type {LodyWorktreeProject} from "acp-extension-core";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread} from "./app-server/v2";

export function readWorktreeProject(meta: unknown): LodyWorktreeProject | undefined {
    if (typeof meta !== "object" || meta === null) return undefined;
    const lody = (meta as Record<string, unknown>)["lody"];
    if (typeof lody !== "object" || lody === null) return undefined;
    const value = (lody as Record<string, unknown>)["worktreeProject"];
    if (value === undefined) return undefined;
    if (typeof value === "object" && value !== null) {
        const project = value as Record<string, unknown>;
        if (project["version"] === 1 && typeof project["originProjectPath"] === "string"
            && path.isAbsolute(project["originProjectPath"]) && !project["originProjectPath"].includes("\0")) {
            return {version: 1, originProjectPath: project["originProjectPath"]};
        }
    }
    throw RequestError.invalidParams(undefined, "worktreeProject requires version 1 and an absolute originProjectPath");
}

/** Uses project APIs only: logical roots must never become execution or sandbox roots. */
export class WorktreeProjects {
    constructor(private readonly client: CodexAppServerClient) {}

    async resolve(project: LodyWorktreeProject | undefined): Promise<string | undefined> {
        if (!project) return undefined;
        const originProjectPath = await realpath(project.originProjectPath);
        const key = projectRootKey(originProjectPath);
        // Codex persists this key as the native project identity. If its target was
        // deleted, preserve Codex's tombstone error instead of guessing by root.
        const response = await this.client.projectCreate({
            idempotencyKey: `acp-project-v1:${createHash("sha256").update(key).digest("hex")}`,
            name: path.basename(originProjectPath) || originProjectPath,
            roots: [{path: originProjectPath}],
        });
        return response.project.id;
    }

    async backfill(thread: Thread, project: LodyWorktreeProject | undefined): Promise<void> {
        if (!project || thread.projectId) return;
        const projectId = await this.resolve(project);
        if (projectId) {
            await this.client.threadProjectUpdate({threadId: thread.id, projectId});
        }
    }
}

function projectRootKey(originProjectPath: string): string {
    const normalized = path.resolve(originProjectPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
