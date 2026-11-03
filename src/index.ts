#!/usr/bin/env node

import {createAcpAgentRouter} from "./AcpAgentRouterFull";
import {runCodexAdapter} from "./AdapterMain";

runCodexAdapter(createAcpAgentRouter);
