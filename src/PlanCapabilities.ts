import type * as acp from "@agentclientprotocol/sdk/unstable";

export function clientSupportsPlanUpdates(
    clientCapabilities?: acp.ClientCapabilities | null,
): boolean {
    return clientCapabilities?.plan != null;
}
