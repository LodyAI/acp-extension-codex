import {realpath} from "node:fs/promises";
import path from "node:path";
import type {CodexAppServerClient} from "./CodexAppServerClient";

type TrustLevel = "trusted" | "untrusted";

/** Persist only the execution directory, through the native process's own config home. */
export async function ensureProjectTrust(
    client: Pick<CodexAppServerClient, "configRead" | "configBatchWrite">,
    cwd: string,
): Promise<TrustLevel> {
    const absolutePath = path.resolve(cwd);
    const canonicalPath = await realpath(absolutePath);
    const response = await client.configRead({includeLayers: true});
    const projectTables = [response.config["projects"], ...(response.layers ?? [])
        .filter(layer => layer.name.type === "user" && !layer.disabledReason)
        .map(layer => isObject(layer.config) ? layer.config["projects"] : undefined)];
    for (const projects of projectTables) {
        if (!isObject(projects)) continue;
        // Never turn an explicit refusal into a lasting or session-only grant.
        for (const [root, config] of Object.entries(projects)) {
            if (isObject(config) && config["trust_level"] === "untrusted"
                && (samePath(root, absolutePath) || samePath(root, canonicalPath))) {
                return "untrusted";
            }
        }
    }
    const userLayer = response.layers?.find(layer =>
        layer.name.type === "user" && !layer.name.profile && !layer.disabledReason);
    if (!userLayer || userLayer.name.type !== "user") {
        throw new Error("Codex did not return its writable user configuration layer");
    }
    const savedProjects = isObject(userLayer.config) ? userLayer.config["projects"] : undefined;
    if (isObject(savedProjects) && Object.entries(savedProjects).some(([root, config]) =>
        samePath(root, canonicalPath) && isObject(config) && config["trust_level"] === "trusted")) {
        return "trusted";
    }
    await client.configBatchWrite({
        filePath: userLayer.name.file,
        expectedVersion: userLayer.version,
        edits: [{
            keyPath: "projects",
            value: {[canonicalPath]: {trust_level: "trusted"}},
            mergeStrategy: "upsert",
        }],
    });
    return "trusted";
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
    const a = path.normalize(left);
    const b = path.normalize(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
