import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {createAcpAgentRouterCore} from "./AcpAgentRouter";

export function createAcpAgentRouter(createAgent: Parameters<typeof createAcpAgentRouterCore>[0]) {
    return createAcpAgentRouterCore(createAgent, acpV2);
}
