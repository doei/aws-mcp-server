import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSsoTools } from "./tools/sso.js";
import { registerLogsTools } from "./tools/logs.js";
import { CLOUDWATCH_ICONS } from "./constants.js";

const server = new McpServer({
  name: "cloudwatch-mcp-server",
  version: "1.0.0",
});

registerSsoTools(server);
registerLogsTools(server);

// Patch the tools/list handler to include the CloudWatch icon on every tool.
// The high-level McpServer API doesn't expose the MCP `icons` field yet,
// so we wrap the underlying protocol handler directly.
const handlers = (server.server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
const originalListTools = handlers.get("tools/list")!;
handlers.set("tools/list", async (request: unknown, extra: unknown) => {
  const result = (await originalListTools(request, extra)) as {
    tools: Array<Record<string, unknown>>;
  };
  for (const tool of result.tools) {
    tool.icons = CLOUDWATCH_ICONS;
  }
  return result;
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cloudwatch-mcp-server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
