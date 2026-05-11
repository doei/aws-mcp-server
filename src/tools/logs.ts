import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetQueryResultsCommand,
  QueryStatus,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodTypeAny } from "zod";
import {
  DEFAULT_LOG_GROUP_LIMIT,
  DEFAULT_LOG_STREAM_LIMIT,
  type Environment,
  INSIGHTS_MAX_ATTEMPTS,
  INSIGHTS_POLL_INTERVAL_MS,
  PROFILES,
  type ProjectConfig,
  type ProjectLogGroup,
  notConfiguredMessage,
} from "../constants.js";
import {
  getCloudWatchClientForEnv,
  isAuthError,
  truncateResponse,
} from "../services/aws.js";

const environmentSchema = z
  .enum(["dev", "staging", "prod"])
  .describe(
    Object.entries(PROFILES)
      .map(([env, profile]) => `"${env}" uses AWS profile "${profile}"`)
      .join("; ")
  );

const flexibleTimestamp = z
  .union([z.string().datetime(), z.number().int().positive()])
  .describe(
    'ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200)'
  );

function toEpochSeconds(value: string | number): number {
  if (typeof value === "number") return value;
  return Math.floor(new Date(value).getTime() / 1000);
}

function authErrorResponse(env: Environment) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Authentication failed for environment "${env}". Please call the aws_sso_login tool with environment "${env}" to refresh credentials, then retry this request.`,
      },
    ],
  };
}

function notConfiguredResponse() {
  return {
    content: [
      { type: "text" as const, text: notConfiguredMessage() },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a schema accepting only the log group names declared in the project config.
 * Each accepted value carries its `description` from `aws-mcp.json` so the agent sees
 * per-value documentation in the tool's input schema.
 */
function buildLogGroupNameSchema(
  logGroups: ProjectLogGroup[]
): ZodTypeAny | null {
  if (logGroups.length === 0) return null;
  if (logGroups.length === 1) {
    const [g] = logGroups;
    return z.literal(g.logGroupName).describe(g.description);
  }
  const literals = logGroups.map((g) =>
    z.literal(g.logGroupName).describe(g.description)
  );
  return z.union(
    literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]
  );
}

async function runInsightsQuery(
  env: Environment,
  logGroupNames: string[],
  query: string,
  startEpoch: number,
  endEpoch: number
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const client = getCloudWatchClientForEnv(env);

  const startResponse = await client.send(
    new StartQueryCommand({
      logGroupNames,
      queryString: query,
      startTime: startEpoch,
      endTime: endEpoch,
    })
  );

  const queryId = startResponse.queryId;
  if (!queryId) {
    return {
      content: [
        {
          type: "text",
          text: "Failed to start Insights query: no query ID returned.",
        },
      ],
    };
  }

  for (let attempt = 0; attempt < INSIGHTS_MAX_ATTEMPTS; attempt++) {
    await sleep(INSIGHTS_POLL_INTERVAL_MS);

    const resultsResponse = await client.send(
      new GetQueryResultsCommand({ queryId })
    );

    const status = resultsResponse.status;

    if (
      status === QueryStatus.Complete ||
      status === QueryStatus.Failed ||
      status === QueryStatus.Cancelled
    ) {
      if (status !== QueryStatus.Complete) {
        return {
          content: [
            {
              type: "text",
              text: `Insights query ended with status "${status}" (queryId: ${queryId}).`,
            },
          ],
        };
      }

      const rows = (resultsResponse.results ?? []).map((row) => {
        const obj: Record<string, string> = {};
        for (const field of row) {
          if (field.field && field.value !== undefined) {
            obj[field.field] = field.value;
          }
        }
        return obj;
      });

      const text = truncateResponse(JSON.stringify(rows, null, 2));
      return { content: [{ type: "text", text }] };
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `Insights query is still running after ${(INSIGHTS_MAX_ATTEMPTS * INSIGHTS_POLL_INTERVAL_MS) / 1000} seconds. Query ID: ${queryId}\n\nYou can inform the user that the query is still processing. They may retry in a moment.`,
      },
    ],
  };
}

const LIST_LOG_GROUPS_DESCRIPTION = `Lists CloudWatch Logs log groups in the specified AWS environment.

Use this tool to discover log groups that aren't declared in the project's aws-mcp.json. For project-declared log groups, call cloudwatch_list_log_streams or cloudwatch_insights_query directly with the log group name.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- prefix (optional): Log group name prefix to filter by, e.g. "myorg/dev" or "myorg/dev/myapp".
- limit (optional, default ${DEFAULT_LOG_GROUP_LIMIT}): Maximum number of log groups to return.

Returns:
A JSON array of objects with fields:
- logGroupName (string): Full name of the log group.
- retentionInDays (number | null): Configured retention period in days, or null if retention is indefinite.`;

const LIST_LOG_STREAMS_DESCRIPTION = `Lists log streams within a CloudWatch log group, ordered by most recent activity.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_name (required): Exact name of the log group. Constrained to project-declared log groups by aws-mcp.json.
- limit (optional, default ${DEFAULT_LOG_STREAM_LIMIT}): Maximum number of streams to return.

Returns:
A JSON array of objects with fields:
- logStreamName (string): Full name of the log stream.
- lastEventTime (string | null): ISO 8601 timestamp of the last log event in this stream, or null if unknown.`;

const INSIGHTS_DESCRIPTION = `Runs a CloudWatch Logs Insights query and returns results. Supports field extraction, filtering (including regex), aggregation, and sorting.

Use this tool to search, filter, or analyze log data. Supports both simple keyword searches and complex analytics. Multiple log groups can be queried in a single call by passing an array.

Time range: You MUST provide start_time (ISO 8601 or Unix epoch seconds). Optionally provide end_time (defaults to now). Always choose a narrow, specific time window to avoid excessive output.

Field discovery: if you don't know what structured fields a log group exposes, start with a small recent query (e.g. \`fields @timestamp, @message | sort @timestamp desc | limit 5\` over the last hour) to inspect the raw messages before writing a targeted query.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_names (required): One log group name, or an array of up to 10. Constrained to project-declared log groups by aws-mcp.json.
- query (required): CloudWatch Logs Insights query string. See examples below.
- start_time (required): Start of the query window — ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200).
- end_time (optional): End of the query window — ISO 8601 or Unix epoch seconds. Defaults to now.

Example queries:
- Recent logs:      fields @timestamp, @message | sort @timestamp desc | limit 20
- Field discovery:  fields @timestamp, @message | sort @timestamp desc | limit 5
- Keyword search:   fields @timestamp, @message | filter @message like /keyword/ | sort @timestamp desc | limit 50
- Error search:     fields @timestamp, @message | filter @message like /(?i)error/ | sort @timestamp desc | limit 50
- Filter by field:  fields @timestamp, @message | filter someField = "value" | sort @timestamp desc | limit 50
- Stats by field:   stats count(*) by someField | sort count(*) desc
- Slow requests:    fields @timestamp, requestId, duration | filter duration > 1000 | sort duration desc

Returns:
On success: A JSON array of result rows.
If still running after ${(INSIGHTS_MAX_ATTEMPTS * INSIGHTS_POLL_INTERVAL_MS) / 1000}s: A message with the query ID.`;

export interface LogsToolsRegistration {
  applyConfig(config: ProjectConfig): void;
}

export function registerLogsTools(server: McpServer): LogsToolsRegistration {
  const placeholderLogGroupName = z
    .string()
    .describe("Log group name (constrained once aws-mcp.json is loaded)");

  const listLogGroups = server.registerTool(
    "cloudwatch_list_log_groups",
    {
      title: "List CloudWatch Log Groups",
      description: LIST_LOG_GROUPS_DESCRIPTION,
      inputSchema: {
        environment: environmentSchema,
        prefix: z
          .string()
          .optional()
          .describe("Log group name prefix to filter results"),
        limit: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_LOG_GROUP_LIMIT)
          .describe(`Maximum results to return (default ${DEFAULT_LOG_GROUP_LIMIT})`),
      },
    },
    async () => notConfiguredResponse()
  );

  const listLogStreams = server.registerTool(
    "cloudwatch_list_log_streams",
    {
      title: "List CloudWatch Log Streams",
      description: LIST_LOG_STREAMS_DESCRIPTION,
      inputSchema: {
        environment: environmentSchema,
        log_group_name: placeholderLogGroupName,
        limit: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_LOG_STREAM_LIMIT)
          .describe(`Maximum streams to return (default ${DEFAULT_LOG_STREAM_LIMIT})`),
      },
    },
    async () => notConfiguredResponse()
  );

  const insightsQuery = server.registerTool(
    "cloudwatch_insights_query",
    {
      title: "CloudWatch Logs Insights Query",
      description: INSIGHTS_DESCRIPTION,
      inputSchema: {
        environment: environmentSchema,
        log_group_names: z
          .union([z.string(), z.array(z.string()).min(1).max(10)])
          .describe(
            "Log group name (string) or array of up to 10 log group names (constrained once aws-mcp.json is loaded)"
          ),
        query: z.string().describe("CloudWatch Logs Insights query string"),
        start_time: flexibleTimestamp.describe(
          'Start of the query window — ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200).'
        ),
        end_time: z
          .union([z.string().datetime(), z.number().int().positive()])
          .optional()
          .describe(
            "End of the query window — ISO 8601 or Unix epoch seconds. Defaults to now."
          ),
      },
    },
    async () => notConfiguredResponse()
  );

  return {
    applyConfig(config: ProjectConfig) {
      const logGroupNameSchema = buildLogGroupNameSchema(config.logGroups);
      if (!logGroupNameSchema) {
        // No log groups declared — keep the CloudWatch tools in their not-configured state.
        return;
      }

      listLogGroups.update({
        callback: async ({ environment, prefix, limit }) => {
          const env = environment as Environment;
          const client = getCloudWatchClientForEnv(env);
          try {
            const response = await client.send(
              new DescribeLogGroupsCommand({
                ...((prefix as string | undefined) ? { logGroupNamePrefix: prefix as string } : {}),
                limit: limit as number,
              })
            );
            const groups = (response.logGroups ?? []).map((g) => ({
              logGroupName: g.logGroupName ?? "",
              retentionInDays: g.retentionInDays ?? null,
            }));
            const text = truncateResponse(JSON.stringify(groups, null, 2));
            return { content: [{ type: "text", text }] };
          } catch (error) {
            if (isAuthError(error)) return authErrorResponse(env);
            throw error;
          }
        },
      });

      listLogStreams.update({
        paramsSchema: {
          environment: environmentSchema,
          log_group_name: logGroupNameSchema,
          limit: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_LOG_STREAM_LIMIT)
            .describe(`Maximum streams to return (default ${DEFAULT_LOG_STREAM_LIMIT})`),
        },
        callback: async (args: Record<string, unknown>) => {
          const env = args.environment as Environment;
          const logGroupName = args.log_group_name as string;
          const limit = args.limit as number;
          const client = getCloudWatchClientForEnv(env);
          try {
            const response = await client.send(
              new DescribeLogStreamsCommand({
                logGroupName,
                orderBy: "LastEventTime",
                descending: true,
                limit,
              })
            );
            const streams = (response.logStreams ?? []).map((s) => ({
              logStreamName: s.logStreamName ?? "",
              lastEventTime:
                s.lastEventTimestamp != null
                  ? new Date(s.lastEventTimestamp).toISOString()
                  : null,
            }));
            const text = truncateResponse(JSON.stringify(streams, null, 2));
            return { content: [{ type: "text", text }] };
          } catch (error) {
            if (isAuthError(error)) return authErrorResponse(env);
            throw error;
          }
        },
      });

      const logGroupNamesSchema = z.union([
        logGroupNameSchema,
        z
          .array(logGroupNameSchema)
          .min(1)
          .max(10)
          .describe("Up to 10 log group names from aws-mcp.json"),
      ]);

      insightsQuery.update({
        paramsSchema: {
          environment: environmentSchema,
          log_group_names: logGroupNamesSchema,
          query: z.string().describe("CloudWatch Logs Insights query string"),
          start_time: flexibleTimestamp.describe(
            'Start of the query window — ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200).'
          ),
          end_time: z
            .union([z.string().datetime(), z.number().int().positive()])
            .optional()
            .describe(
              "End of the query window — ISO 8601 or Unix epoch seconds. Defaults to now."
            ),
        },
        callback: async (args: Record<string, unknown>) => {
          const env = args.environment as Environment;
          const logGroupNames = args.log_group_names as string | string[];
          const query = args.query as string;
          const startTime = args.start_time as string | number;
          const endTime = args.end_time as string | number | undefined;
          try {
            const startEpoch = toEpochSeconds(startTime);
            const endEpoch = endTime
              ? toEpochSeconds(endTime)
              : Math.floor(Date.now() / 1000);
            const names = Array.isArray(logGroupNames)
              ? logGroupNames
              : [logGroupNames];
            return await runInsightsQuery(env, names, query, startEpoch, endEpoch);
          } catch (error) {
            if (isAuthError(error)) return authErrorResponse(env);
            throw error;
          }
        },
      });
    },
  };
}
