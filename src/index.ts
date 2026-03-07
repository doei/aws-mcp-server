import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSsoTools } from "./tools/sso.js";
import { registerLogsTools } from "./tools/logs.js";

const server = new McpServer({
  name: "cloudwatch-mcp-server",
  version: "1.0.0",
});

registerSsoTools(server);
registerLogsTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cloudwatch-mcp-server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
