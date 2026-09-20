import {createHash} from "node:crypto";
import {realpath} from "node:fs/promises";
import path from "node:path";
import {RequestError} from "@agentclientprotocol/sdk";
import type {LodyWorktreeProject} from "acp-extension-core";
import {ErrorCodes, ResponseError} from "vscode-jsonrpc/node";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread} from "./app-server/v2";

const MAX_PROJECT_IDENTITY_GENERATION = 32;

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
        const baseIdempotencyKey = `acp-project-v1:${createHash("sha256").update(key).digest("hex")}`;
        for (let generation = 0; generation <= MAX_PROJECT_IDENTITY_GENERATION; generation++) {
            const idempotencyKey = generation === 0
                ? baseIdempotencyKey
                : `${baseIdempotencyKey}:g${generation}`;
            try {
                const response = await this.client.projectCreate({
                    idempotencyKey,
                    name: path.basename(originProjectPath) || originProjectPath,
                    roots: [{path: originProjectPath}],
                });
                return response.project.id;
            } catch (error) {
                if (!isDeletedIdempotencyProject(error, idempotencyKey)) throw error;
            }
        }
        throw RequestError.internalError(
            {originProjectPath, maxGeneration: MAX_PROJECT_IDENTITY_GENERATION},
            `Codex project recovery for ${originProjectPath} exhausted generations 0 through ${MAX_PROJECT_IDENTITY_GENERATION}`,
        );
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

function isDeletedIdempotencyProject(error: unknown, idempotencyKey: string): boolean {
    return error instanceof ResponseError
        && error.code === ErrorCodes.InternalError
        && error.message.includes(`idempotency key refers to deleted project: ${idempotencyKey}`);
}
