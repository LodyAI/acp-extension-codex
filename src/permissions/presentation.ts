import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {
    AdditionalPermissionProfile,
    FileChangeRequestApprovalParams,
    RequestPermissionProfile,
    ThreadItem,
} from "../app-server/v2";
import type {PermissionPromptContext} from "./lifecycle";

type FileChangeItem = ThreadItem & {type: "fileChange"};
export function fileChangeToolCall(
    params: FileChangeRequestApprovalParams,
    permissionContext: PermissionPromptContext,
): acp.ToolCallUpdate {
    const item = permissionContext.fileChange(params.threadId, params.itemId);
    return {
        toolCallId: params.itemId,
        kind: "edit",
        status: "pending",
        title: "Edit files",
        ...locationsField(fileChangePaths(item)),
    };
}

export function additionalPermissionsToolCall(
    itemId: string,
    cwd: string,
    environmentId: string | null,
    permissions: RequestPermissionProfile,
): acp.ToolCallUpdate {
    const content = permissionProfileContent(permissions);
    return {
        toolCallId: itemId,
        name: "request_permissions",
        kind: "other",
        status: "pending",
        title: "Additional sandbox permissions",
        rawInput: {permissions, cwd, environmentId},
        ...locationsField(permissionProfilePaths(permissions)),
        ...(content.length > 0 ? {content} : {}),
    };
}

function fileChangePaths(item?: FileChangeItem): string[] {
    return unique(item?.changes.map(change => change.path) ?? []);
}

function permissionProfilePaths(permissions?: RequestPermissionProfile | AdditionalPermissionProfile | null): string[] {
    const fileSystem = permissions?.fileSystem;
    return unique([
        ...(fileSystem?.read ?? []),
        ...(fileSystem?.write ?? []),
        ...(fileSystem?.entries ?? []).flatMap(entry => entry.path.type === "path" ? [entry.path.path] : []),
    ]);
}

function permissionProfileContent(
    permissions: RequestPermissionProfile | AdditionalPermissionProfile,
): acp.ToolCallContent[] {
    const lines: string[] = [];
    const networkEnabled = permissions.network?.enabled;
    if (networkEnabled !== null && networkEnabled !== undefined) {
        lines.push(networkEnabled ? "Enable network access" : "Disable network access");
    }
    for (const entry of permissions.fileSystem?.entries ?? []) {
        switch (entry.path.type) {
            case "glob_pattern":
                lines.push(`${entry.access} filesystem pattern ${entry.path.pattern}`);
                break;
            case "special":
                lines.push(`${entry.access} Codex filesystem scope ${JSON.stringify(entry.path.value)}`);
                break;
            case "path":
                break;
        }
    }
    return lines.length > 0 ? [textContent(lines.join("\n"))] : [];
}

function locationsField(paths: string[]): Pick<acp.ToolCallUpdate, "locations"> | object {
    return paths.length > 0 ? {locations: paths.map(path => ({path}))} : {};
}

function textContent(text: string): acp.ToolCallContent {
    return {type: "content", content: {type: "text", text}};
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}
