const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const REGION = requiredEnv("AWS_REGION");

export const PROFILES: Record<Environment, string> = {
  dev: requiredEnv("AWS_DEV_PROFILE"),
  staging: requiredEnv("AWS_STAGING_PROFILE"),
  prod: requiredEnv("AWS_PROD_PROFILE"),
};

export const DEFAULT_LOG_GROUP_LIMIT = 50;
export const DEFAULT_LOG_STREAM_LIMIT = 20;
export const MAX_RESPONSE_LENGTH = 50_000;
export const SSO_LOGIN_TIMEOUT_MS = 120_000;
export const INSIGHTS_POLL_INTERVAL_MS = 2_000;
export const INSIGHTS_MAX_ATTEMPTS = 15;

/**
 * Top-level instructions sent to the client during MCP initialize.
 * Always present, regardless of project-config state, so the agent
 * knows up front what this server requires and how to interpret a
 * "not configured" tool response.
 */
export const SERVER_INSTRUCTIONS = `aws-mcp-server requires an "aws-mcp.json" file at the root of the project being worked in. The server discovers this file via the workspace roots reported by the MCP client.

The file declares which CloudWatch log groups and SQS queues the project cares about, and constrains the tools' schemas to those values:

\`\`\`json
{
  "logGroups": [
    { "logGroupName": "myorg/dev/myapp", "description": "Main app logs (dev)" }
  ],
  "queues": [
    { "queueName": "order-processing-dev", "description": "Processes new orders" }
  ]
}
\`\`\`

If a tool returns a "not configured" error, advise the user to add an "aws-mcp.json" file at the project root (or fix its contents) and restart this MCP server.

For SQS tools, queues are addressed by name (\`queue_name\`); the server resolves the URL from the AWS profile's credentials. AWS account IDs and queue URLs are not needed in tool calls or in the project config.`;

const NOT_CONFIGURED_MESSAGE = `aws-mcp-server is not configured: no usable "aws-mcp.json" was found in the workspace roots reported by the MCP client. Add an "aws-mcp.json" file at the root of your project (with at least a "logGroups" or "queues" array) and restart this MCP server.`;

export function notConfiguredMessage(detail?: string): string {
  return detail ? `${NOT_CONFIGURED_MESSAGE}\n\nDetail: ${detail}` : NOT_CONFIGURED_MESSAGE;
}

export interface ProjectLogGroup {
  logGroupName: string;
  description: string;
}

export interface ProjectQueue {
  queueName: string;
  description: string;
}

export interface ProjectConfig {
  logGroups: ProjectLogGroup[];
  queues: ProjectQueue[];
}

function svgToIconEntry(svg: string) {
  return [
    {
      src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      mimeType: "image/svg+xml" as const,
      sizes: ["48x48"],
    },
  ];
}

const CLOUDWATCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#E7157B"/>
  <path d="M10 34 L17 24 L22 28 L28 18 L34 22 L38 14" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38" cy="14" r="2.5" fill="#fff"/>
</svg>`;

const SQS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#E7157B"/>
  <path d="M14 16h20v4H14zM14 24h20v4H14zM14 32h20v4H14z" fill="#fff" opacity="0.9"/>
  <path d="M10 14v24l4-2V16z" fill="#fff" opacity="0.6"/>
  <path d="M38 14v24l-4-2V16z" fill="#fff" opacity="0.6"/>
</svg>`;

const AWS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#232F3E"/>
  <path d="M15 28c0 0 3 4 9 4s9-4 9-4" stroke="#FF9900" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <path d="M34 28l3 2-3 2" stroke="#FF9900" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16 20c0 0 2-4 8-4s8 4 8 4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;

export const CLOUDWATCH_ICONS = svgToIconEntry(CLOUDWATCH_ICON_SVG);
export const SQS_ICONS = svgToIconEntry(SQS_ICON_SVG);
export const AWS_ICONS = svgToIconEntry(AWS_ICON_SVG);
