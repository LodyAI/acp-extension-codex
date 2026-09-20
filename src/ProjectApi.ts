/** Project API subset from Codex 0.154.0's experimental schema, omitted by stable generate-ts. */
export type ProjectCreateParams = {
    idempotencyKey: string;
    name: string;
    roots: Array<{path: string}>;
};
export type ProjectCreateResponse = {project: {id: string}};
export type ThreadProjectUpdateParams = {threadId: string; projectId: string};

export type CodexProjectRequest =
    | {method: "project/create"; params: ProjectCreateParams}
    | {method: "thread/metadata/update"; params: ThreadProjectUpdateParams};
