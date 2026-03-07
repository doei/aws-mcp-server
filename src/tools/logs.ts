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
  DEFAULT_TIME_WINDOW_MINUTES,
  type Environment,
  INSIGHTS_MAX_ATTEMPTS,
  INSIGHTS_POLL_INTERVAL_MS,
  LOG_PREFIXES,
  PROFILES,
} from "../constants.js";
import {
  getClientForEnv,
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

function authErrorResponse(env: Environment) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Authentication failed for environment "${env}". Please call the cloudwatch_sso_login tool with environment "${env}" to refresh credentials, then retry this request.`,
      },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
- suffix (optional): Additional filter appended to the environment prefix. Example: "trench" would match "${LOG_PREFIXES.staging}/trench" in staging.
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
            .describe("Additional filter appended to environment prefix, e.g. \"trench\" or \"anorak/worker\""),
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
      const client = getClientForEnv(env);
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
      const client = getClientForEnv(env);
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

Time range: Provide start_time/end_time (ISO 8601) for an exact window, or use minutes_ago for a relative lookback from now. If both start_time and minutes_ago are given, start_time takes precedence.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- log_group_name (required): Exact name of the log group to query.
- query (required): CloudWatch Logs Insights query string. Examples:
  - "fields @timestamp, @message | sort @timestamp desc | limit 20"
  - "fields @timestamp, @message | filter @message like /(?i)error/ | sort @timestamp desc | limit 20"
  - "stats count(*) as errorCount by level | sort errorCount desc"
  - "fields @timestamp, requestId, duration | filter duration > 1000 | sort duration desc"
- start_time (optional): ISO 8601 datetime for the start of the query window, e.g. "2026-03-01T00:00:00Z". Takes precedence over minutes_ago.
- end_time (optional): ISO 8601 datetime for the end of the query window. Defaults to now.
- minutes_ago (optional, default ${DEFAULT_TIME_WINDOW_MINUTES}): Relative lookback in minutes from end_time. Ignored when start_time is provided.

Returns:
On success: A JSON array of result rows.
If still running after ${(INSIGHTS_MAX_ATTEMPTS * INSIGHTS_POLL_INTERVAL_MS) / 1000}s: A message with the query ID.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          log_group_name: z
            .string()
            .describe("Exact name of the log group to query"),
          query: z
            .string()
            .describe("CloudWatch Logs Insights query string"),
          start_time: z
            .string()
            .datetime()
            .optional()
            .describe(
              'ISO 8601 datetime for the start of the query window, e.g. "2026-03-01T00:00:00Z". Takes precedence over minutes_ago.'
            ),
          end_time: z
            .string()
            .datetime()
            .optional()
            .describe(
              'ISO 8601 datetime for the end of the query window. Defaults to now.'
            ),
          minutes_ago: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_TIME_WINDOW_MINUTES)
            .describe(
              `Relative lookback in minutes from end_time (default ${DEFAULT_TIME_WINDOW_MINUTES}). Ignored when start_time is provided.`
            ),
        })
        .strict(),
    },
    async ({ environment, log_group_name, query, start_time, end_time, minutes_ago }) => {
      const env = environment as Environment;
      const client = getClientForEnv(env);
      try {
        const endEpoch = end_time
          ? Math.floor(new Date(end_time).getTime() / 1000)
          : Math.floor(Date.now() / 1000);
        const startEpoch = start_time
          ? Math.floor(new Date(start_time).getTime() / 1000)
          : endEpoch - minutes_ago * 60;

        const startResponse = await client.send(
          new StartQueryCommand({
            logGroupName: log_group_name,
            queryString: query,
            startTime: startEpoch,
            endTime: endEpoch,
          })
        );

        const queryId = startResponse.queryId;
        if (!queryId) {
          return {
            content: [{ type: "text", text: "Failed to start Insights query: no query ID returned." }],
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
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );
}
