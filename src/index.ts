import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSsoTools } from "./tools/sso.js";
import { registerLogsTools } from "./tools/logs.js";
import { registerSqsTools } from "./tools/sqs.js";
import {
  AWS_ICONS,
  CLOUDWATCH_ICONS,
  SERVER_INSTRUCTIONS,
  SQS_ICONS,
  type ProjectConfig,
} from "./constants.js";
import { loadProjectConfigFromRoots } from "./projectConfig.js";

const server = new McpServer(
  {
    name: "aws-mcp-server",
    version: "2.1.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

const ssoTools = registerSsoTools(server);
const logsTools = registerLogsTools(server);
const sqsTools = registerSqsTools(server);

// Patch the tools/list handler to include service-specific icons on every tool.
// The high-level McpServer API doesn't expose the MCP `icons` field yet,
// so we wrap the underlying protocol handler directly.
const handlers = (server.server as unknown as {
  _requestHandlers: Map<string, Function>;
})._requestHandlers;
const originalListTools = handlers.get("tools/list")!;
handlers.set("tools/list", async (request: unknown, extra: unknown) => {
  const result = (await originalListTools(request, extra)) as {
    tools: Array<Record<string, unknown>>;
  };
  for (const tool of result.tools) {
    const name = tool.name as string;
    if (name.startsWith("cloudwatch_")) {
      tool.icons = CLOUDWATCH_ICONS;
    } else if (name.startsWith("sqs_")) {
      tool.icons = SQS_ICONS;
    } else {
      tool.icons = AWS_ICONS;
    }
  }
  return result;
});

function applyConfig(config: ProjectConfig): void {
  ssoTools.applyConfig();
  logsTools.applyConfig(config);
  sqsTools.applyConfig(config);
}

async function loadConfigFromClient(): Promise<void> {
  const clientCapabilities = server.server.getClientCapabilities();
  if (!clientCapabilities?.roots) {
    console.error(
      "aws-mcp-server: client did not advertise the `roots` capability — server stays in not-configured state. All tools will return a not-configured error."
    );
    return;
  }

  let rootsResult;
  try {
    rootsResult = await server.server.listRoots();
  } catch (err) {
    console.error(
      `aws-mcp-server: roots/list request failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const rootUris = (rootsResult.roots ?? []).map((r) => r.uri);
  const loaded = loadProjectConfigFromRoots(rootUris);

  if (loaded.warnings.length > 0) {
    console.error("=".repeat(60));
    console.error("aws-mcp-server: project config loaded with warnings:");
    for (const warning of loaded.warnings) {
      console.error(`  - ${warning}`);
    }
    console.error("=".repeat(60));
  }

  if (!loaded.config) {
    const searched = loaded.searchedRoots.length
      ? loaded.searchedRoots.join(", ")
      : "<none>";
    console.error(
      `aws-mcp-server: no usable aws-mcp.json found under workspace roots [${searched}]. All tools will return a not-configured error.`
    );
    return;
  }

  console.error(
    `aws-mcp-server: project config loaded from "${loaded.discoveredPath}" (queues: ${loaded.config.queues.length}, logGroups: ${loaded.config.logGroups.length})`
  );
  applyConfig(loaded.config);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("aws-mcp-server running on stdio");

  // The client must finish the initialize handshake before we can ask it for
  // its workspace roots. If it never sends `notifications/initialized` we
  // simply stay in the not-configured state — no fallback to process.cwd().
  server.server.oninitialized = () => {
    void loadConfigFromClient().catch((err) => {
      console.error(
        `aws-mcp-server: unexpected error while loading project config: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
      );
    });
  };
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
