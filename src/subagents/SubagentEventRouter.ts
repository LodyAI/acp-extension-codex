import type {CodexSubagentEventRouter} from "./CodexSubagentEventRouter";

/** AIR and standard sessions expose the same routing surface, not the same lifetime rules. */
export type SubagentEventRouter = Pick<CodexSubagentEventRouter, Exclude<keyof CodexSubagentEventRouter, "connectionForEvents">> & {
    connectionForEvents?: CodexSubagentEventRouter["connectionForEvents"];
    withUserAction?<T>(sessionId: string, itemId: string | undefined, request: () => Promise<T>, turnId?: string | null): Promise<T>;
};
