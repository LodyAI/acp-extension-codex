# MCP Apps extension

MCP Apps ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps)) let an MCP tool
declare an interactive `ui://` HTML resource. The adapter owns the MCP connections, so
the client renders the app while every resource read and tool call the app makes goes
back through the adapter, scoped to the tool call that opened it. Methods and payload
types come from `acp-extension-core` (`LodyMcpApp*`).

## Capability negotiation

- The client advertises `clientCapabilities._meta.lody.mcpApps: {"version": 1}`
  (ACP v2: `capabilities._meta.lody.mcpApps`).
- The adapter advertises `agentCapabilities._meta.lody.mcpApps: {"version": 1}`
  (ACP v2: `capabilities._meta.lody.mcpApps`).
- The `_lody/mcp_apps/*` requests are served on both ACP v1 and v2 connections.

Only when the client advertised the capability does the adapter declare
`capabilities.extensions["io.modelcontextprotocol/ui"] = {"mimeTypes": ["text/html;profile=mcp-app"]}`
in the Codex app-server `initialize` (ACP `initialize` always precedes it), and attach
app metadata to tool calls. Without the extension, spec-following MCP servers may omit
UI resources.

## Tool call descriptor

A Codex `mcpToolCall` item opens an app when the first of `mcpAppUi.resourceUri`,
`appContext.resourceUri`, and the deprecated `mcpAppResourceUri` that starts with
`ui://` is present. Its ACP `tool_call` (live and history replay) then carries:

```json
{
  "_meta": {
    "is_mcp_tool_call": true,
    "lody": {
      "mcpApp": {
        "version": 1,
        "server": "codex_apps",
        "tool": "explore_graph",
        "resourceUri": "ui://graph/explorer.html",
        "appName": "Graph",
        "preferredDisplayMode": "inline"
      }
    }
  }
}
```

Title and kind are unchanged. The descriptor stays small; HTML, tool input, and tool
result are fetched on demand.

## Requests

All requests carry `sessionId` and `toolCallId` (the Codex item id; the adapter uses it
as the ACP `toolCallId`). Calls not in memory — for example after an adapter restart —
are resolved by reading the session's thread history once.

- `_lody/mcp_apps/load` returns `{app, toolInput, toolResult}`; `toolResult` is `null`
  until the call completes.
- `_lody/mcp_apps/resource/read` (`uri`) forwards to app-server `mcpServer/resource/read`
  with the originating thread, `originCallId`, server, and connector.
- `_lody/mcp_apps/tool/call` (`name`, optional `arguments`) forwards to app-server
  `mcpServer/tool/call` on the originating server only. The tool must be listed by that
  server (`mcpServerStatus/list`), and a declared `_meta.ui.visibility` must include
  `"app"`; an absent visibility allows the call.

Unknown sessions, unknown or app-less tool calls, and refused tools fail with
`invalid params` (`-32602`); a client that did not negotiate the capability gets
`invalid request` (`-32600`). App-server JSON-RPC errors keep their code, message,
and data.
