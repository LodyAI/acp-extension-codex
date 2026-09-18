import type * as acp from "@agentclientprotocol/sdk";
import {recordOrNull} from "./permissions/json";

export function clientSupportsFormElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.form != null;
}

export function clientSupportsUrlElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.url != null;
}

export function clientSupportsElicitationAnswerNotes(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    const lody = recordOrNull(clientCapabilities?._meta?.["lody"]);
    const elicitation = recordOrNull(lody?.["elicitation"]);
    return clientSupportsFormElicitation(clientCapabilities)
        && elicitation?.["version"] === 1
        && elicitation["answerNotes"] === true;
}
