import {
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetQueryResultsCommand,
  QueryStatus,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_LOG_GROUP_LIMIT,
  DEFAULT_LOG_STREAM_LIMIT,
  type Environment,
  INSIGHTS_MAX_ATTEMPTS,
  INSIGHTS_POLL_INTERVAL_MS,
  LOG_PREFIXES,
  PROJECT_CONFIG,
  PROFILES,
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

// Accepts either an ISO 8601 string or Unix epoch seconds (integer).
const flexibleTimestamp = z
  .union([z.string().datetime(), z.number().int().positive()])
  .describe(
    'ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200)'
  );

// Accepts a single log group name or an array of up to 10 (CloudWatch limit).
const logGroupNamesSchema = z
  .union([z.string(), z.array(z.string()).min(1).max(10)])
  .describe(
    "Log group name (string) or array of up to 10 log group names to query simultaneously"
  );

function toLogGroupNamesArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the "Known log groups" section injected into tool descriptions when CW_PROJECT_CONFIG is set. */
function projectLogGroupsSection(): string {
  if (!PROJECT_CONFIG || PROJECT_CONFIG.logGroups.length === 0) return "";
  const lines = PROJECT_CONFIG.logGroups.map(
    (g) => `  - {prefix}/${g.suffix} — ${g.description}`
  );
  return `\n\nKnown log groups for this project (replace {prefix} with the environment's log group prefix):\n${lines.join("\n")}`;
}

/** Runs a CloudWatch Insights query and polls until complete. Shared by insights and sample_logs tools. */
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

export function registerLogsTools(server: McpServer): void {
  server.registerTool(
    "cloudwatch_list_log_groups",
    {
      title: "List CloudWatch Log Groups",
      description: `Lists CloudWatch Logs log groups in the specified AWS environment.

Results are automatically scoped to the environment's log group prefix (${Object.entries(LOG_PREFIXES).map(([e, p]) => `${e}: "${p}"`).join(", ")}). You can optionally narrow further with a suffix filter.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- suffix (optional): Additional filter appended to the environment prefix. Example: "my-service" would match "${LOG_PREFIXES.staging}/my-service" in staging.
- limit (optional, default ${DEFAULT_LOG_GROUP_LIMIT}): Maximum number of log groups to return.

Returns:
A JSON array of objects with fields:
- logGroupName (string): Full name of the log group.
- retentionInDays (number | null): Configured retention period in days, or null if retention is indefinite.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          suffix: z
            .string()
            .optional()
            .describe(
              'Additional filter appended to environment prefix, e.g. "my-service" or "my-service/worker"'
            ),
          limit: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_LOG_GROUP_LIMIT)
            .describe(`Maximum results to return (default ${DEFAULT_LOG_GROUP_LIMIT})`),
        })
        .strict(),
    },
    async ({ environment, suffix, limit }) => {
      const env = environment as Environment;
      const client = getCloudWatchClientForEnv(env);
      const prefix = suffix
        ? `${LOG_PREFIXES[env]}/${suffix}`
        : LOG_PREFIXES[env];
      try {
        const response = await client.send(
          new DescribeLogGroupsCommand({
            logGroupNamePrefix: prefix,
            limit,
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
    }
  );

  server.registerTool(
    "cloudwatch_list_log_streams",
    {
      title: "List CloudWatch Log Streams",
      description: `Lists log streams within a CloudWatch log group, ordered by most recent activity.

Use this tool to find active log streams before querying logs.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_name (required): Exact name of the log group to list streams from.
- limit (optional, default ${DEFAULT_LOG_STREAM_LIMIT}): Maximum number of streams to return.

Returns:
A JSON array of objects with fields:
- logStreamName (string): Full name of the log stream.
- lastEventTime (string | null): ISO 8601 timestamp of the last log event in this stream, or null if unknown.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          log_group_name: z
            .string()
            .describe("Exact name of the log group"),
          limit: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_LOG_STREAM_LIMIT)
            .describe(`Maximum streams to return (default ${DEFAULT_LOG_STREAM_LIMIT})`),
        })
        .strict(),
    },
    async ({ environment, log_group_name, limit }) => {
      const env = environment as Environment;
      const client = getCloudWatchClientForEnv(env);
      try {
        const response = await client.send(
          new DescribeLogStreamsCommand({
            logGroupName: log_group_name,
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
    }
  );

  server.registerTool(
    "cloudwatch_insights_query",
    {
      title: "CloudWatch Logs Insights Query",
      description: `Runs a CloudWatch Logs Insights query and returns results. Supports field extraction, filtering (including regex), aggregation, and sorting.

Use this tool to search, filter, or analyze log data. Supports both simple keyword searches and complex analytics.

You can query multiple log groups simultaneously by passing an array of names — useful for searching across related groups (e.g. app + worker) in a single call.

Time range: You MUST provide start_time (ISO 8601 or Unix epoch seconds). Optionally provide end_time (defaults to now). Always choose a narrow, specific time window to avoid excessive output.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_names (required): Log group name (string) or array of up to 10 log group names.
- query (required): CloudWatch Logs Insights query string. See examples below.
- start_time (required): Start of the query window — ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200).
- end_time (optional): End of the query window — ISO 8601 or Unix epoch seconds. Defaults to now.${projectLogGroupsSection()}

Example queries:
- Recent logs:      fields @timestamp, @message | sort @timestamp desc | limit 20
- Keyword search:   fields @timestamp, @message | filter @message like /keyword/ | sort @timestamp desc | limit 50
- Error search:     fields @timestamp, @message | filter @message like /(?i)error/ | sort @timestamp desc | limit 50
- Filter by field:  fields @timestamp, @message | filter someField = "value" | sort @timestamp desc | limit 50
- Stats by field:   stats count(*) by someField | sort count(*) desc
- Slow requests:    fields @timestamp, requestId, duration | filter duration > 1000 | sort duration desc

Returns:
On success: A JSON array of result rows.
If still running after ${(INSIGHTS_MAX_ATTEMPTS * INSIGHTS_POLL_INTERVAL_MS) / 1000}s: A message with the query ID.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          log_group_names: logGroupNamesSchema,
          query: z
            .string()
            .describe("CloudWatch Logs Insights query string"),
          start_time: flexibleTimestamp.describe(
            'Start of the query window — ISO 8601 string (e.g. "2026-03-07T12:00:00Z") or Unix epoch seconds (e.g. 1741363200).'
          ),
          end_time: z
            .union([z.string().datetime(), z.number().int().positive()])
            .optional()
            .describe(
              "End of the query window — ISO 8601 or Unix epoch seconds. Defaults to now."
            ),
        })
        .strict(),
    },
    async ({ environment, log_group_names, query, start_time, end_time }) => {
      const env = environment as Environment;
      try {
        const startEpoch = toEpochSeconds(start_time);
        const endEpoch = end_time
          ? toEpochSeconds(end_time)
          : Math.floor(Date.now() / 1000);
        const names = toLogGroupNamesArray(log_group_names);
        return await runInsightsQuery(env, names, query, startEpoch, endEpoch);
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );

  server.registerTool(
    "cloudwatch_sample_logs",
    {
      title: "Sample CloudWatch Logs",
      description: `Fetches a small number of recent log entries from one or more log groups. Use this to discover what structured fields are available before writing a targeted query.

The result shows raw log entries including any JSON fields present in @message. Once you know the field names, use cloudwatch_insights_query with structured filters for precise searches.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_names (required): Log group name (string) or array of up to 10 log group names.
- minutes (optional, default 60): How many minutes back to look for recent entries.
- limit (optional, default 5): Number of log entries to return (max 20).${projectLogGroupsSection()}

Returns:
A JSON array of recent log entries with @timestamp and @message fields.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          log_group_names: logGroupNamesSchema,
          minutes: z
            .number()
            .int()
            .positive()
            .default(60)
            .describe("How many minutes back to look for recent entries (default 60)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("Number of log entries to return, max 20 (default 5)"),
        })
        .strict(),
    },
    async ({ environment, log_group_names, minutes, limit }) => {
      const env = environment as Environment;
      try {
        const endEpoch = Math.floor(Date.now() / 1000);
        const startEpoch = endEpoch - minutes * 60;
        const names = toLogGroupNamesArray(log_group_names);
        const query = `fields @timestamp, @message | sort @timestamp desc | limit ${limit}`;
        return await runInsightsQuery(env, names, query, startEpoch, endEpoch);
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );
}
