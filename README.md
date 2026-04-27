# aws-mcp-server

A local MCP server that connects AI agents (Cursor, Claude Desktop, etc.) to AWS services across multiple AWS accounts using SSO authentication.

## Features

- **CloudWatch Logs** — query logs across **dev**, **staging**, and **prod** environments
- **SQS** — list queues, send messages, inspect queue attributes
- AWS SSO authentication with profile-based credentials
- Seven tools: SSO login, list log groups, list log streams, Insights queries, list queues, send message, get queue attributes
- Query **multiple log groups in a single call** (up to 10)
- Accepts **ISO 8601 or Unix epoch seconds** for time ranges
- **Project config** (`aws-mcp.json` at your repo root, auto-discovered) bakes known log group names and queue names into tool descriptions
- Config parse warnings surfaced to the agent (baked into tool descriptions) and to stderr at startup
- Automatic auth-error detection with helpful retry instructions
- Response truncation at 50,000 characters to keep context manageable

## Prerequisites

- Node.js 18+
- AWS CLI v2 with SSO configured (`aws configure sso`)
- AWS SSO profiles configured in `~/.aws/config` (see Account & Profile Mapping below)

## Setup

```bash
cd aws-mcp-server
npm install
npm run build
```

## Cursor MCP Configuration

Add the following to `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "aws": {
      "command": "node",
      "args": ["/absolute/path/to/aws-mcp-server/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/aws-mcp-server` with the actual path on your system (e.g. `/Users/yourname/aws-mcp-server`).

Restart Cursor after saving `mcp.json`.

## Account & Profile Mapping

| Environment | Env Var              |
|-------------|----------------------|
| dev         | `AWS_DEV_PROFILE`    |
| staging     | `AWS_STAGING_PROFILE`|
| prod        | `AWS_PROD_PROFILE`   |

Set these environment variables to your AWS SSO profile names (e.g. `export AWS_DEV_PROFILE=myorg-dev`).

Additionally set:

| Env Var              | Description                                        |
|----------------------|----------------------------------------------------|
| `AWS_REGION`         | AWS region for all API calls (e.g. `eu-west-1`)    |

## Project Config (Optional)

Drop a single file named **`aws-mcp.json`** at the root of your project to describe its log groups and queues.

```json
{
  "logGroups": [
    { "logGroupName": "myorg/dev/myapp", "description": "Main application logs (dev)" },
    { "logGroupName": "myorg/prod/myapp", "description": "Main application logs (prod)" }
  ],
  "queues": [
    { "queueName": "order-processing", "description": "Processes new orders" },
    { "queueName": "email-notifications", "description": "Sends email notifications" }
  ]
}
```

Names and descriptions are baked into tool descriptions for agent discoverability, so the agent doesn't need a discovery round-trip to know which resources are relevant.

### Discovery

On startup the server resolves the config file in this order:

1. If `AWS_PROJECT_CONFIG` is set, that path is used (absolute or relative to the server's CWD). Useful for absolute paths or unusual layouts.
2. Otherwise, the server walks up from its current working directory looking for `aws-mcp.json`, stopping at the first match or at the enclosing git repository root.
3. If nothing is found, all tools work without project context.

The discovery result and any parse warnings are logged to stderr at startup, and warnings are also injected into tool descriptions so the agent can surface them to you.

## Tools

### `aws_sso_login`

Initiates AWS SSO login for an environment, opening a browser window.

| Parameter   | Type                          | Required | Description                  |
|-------------|-------------------------------|----------|------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | Target AWS environment       |

**Usage note:** After calling this tool, the agent will prompt you to approve the login in your browser. Only retry your original request after confirming in the browser.

---

### `cloudwatch_list_log_groups`

Lists CloudWatch log groups with optional name-prefix filtering.

| Parameter   | Type                          | Required | Default | Description                              |
|-------------|-------------------------------|----------|---------|------------------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                   |
| prefix      | `string`                      | No       | —       | Filter by log group name prefix          |
| limit       | `number`                      | No       | 50      | Maximum number of log groups to return   |

**Returns:** Array of `{ logGroupName, retentionInDays }`.

---

### `cloudwatch_list_log_streams`

Lists log streams in a log group, most recently active first.

| Parameter      | Type                          | Required | Default | Description                            |
|----------------|-------------------------------|----------|---------|----------------------------------------|
| environment    | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                 |
| log_group_name | `string`                      | Yes      | —       | Full log group name                    |
| limit          | `number`                      | No       | 20      | Maximum number of streams to return    |

**Returns:** Array of `{ logStreamName, lastEventTime }`.

---

### `cloudwatch_insights_query`

Runs a CloudWatch Logs Insights query and polls for results. Supports querying multiple log groups in a single call.

| Parameter       | Type                              | Required | Default | Description                                                        |
|-----------------|-----------------------------------|----------|---------|--------------------------------------------------------------------|
| environment     | `"dev" \| "staging" \| "prod"`     | Yes      | —       | Target AWS environment                                             |
| log_group_names | `string \| string[]`              | Yes      | —       | Log group name or array of up to 10 log group names                |
| query           | `string`                          | Yes      | —       | Logs Insights query string                                         |
| start_time      | `string \| number`                | Yes      | —       | ISO 8601 string or Unix epoch seconds                              |
| end_time        | `string \| number`                | No       | now     | ISO 8601 string or Unix epoch seconds                              |

**Returns:** Array of result row objects, or a "still running" message with the query ID.

**Example queries:**
```
fields @timestamp, @message | sort @timestamp desc | limit 20
fields @timestamp, @message | sort @timestamp desc | limit 5
fields @timestamp, @message | filter @message like /(?i)error/ | sort @timestamp desc | limit 50
fields @timestamp, @message | filter someField = "value" | sort @timestamp desc | limit 50
stats count(*) by someField | sort count(*) desc
fields @timestamp, requestId, duration | filter duration > 1000 | sort duration desc
```

To discover available fields in an unfamiliar log group, run a small recent query (e.g. `limit 5` over the last hour) and inspect the raw `@message` content before writing structured filters.

---

### `sqs_list_queues`

Lists SQS queues in the specified environment.

| Parameter   | Type                          | Required | Default | Description                            |
|-------------|-------------------------------|----------|---------|----------------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                 |
| prefix      | `string`                      | No       | —       | Filter queues by name prefix           |
| limit       | `number`                      | No       | 50      | Maximum number of queues to return     |

**Returns:** Array of `{ queueUrl, queueName }`.

---

### `sqs_send_message`

Sends a message to an SQS queue. Supports standard and FIFO queues, message attributes, and delayed delivery.

| Parameter          | Type                          | Required | Default | Description                                                             |
|--------------------|-------------------------------|----------|---------|-------------------------------------------------------------------------|
| environment        | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                                                  |
| queue_url          | `string`                      | Yes      | —       | Full SQS queue URL                                                      |
| message_body       | `string`                      | Yes      | —       | Message content (plain text or JSON)                                    |
| message_group_id   | `string`                      | No       | —       | Message group ID (required for FIFO queues)                             |
| deduplication_id   | `string`                      | No       | —       | Deduplication token (required for FIFO without content-based dedup)     |
| delay_seconds      | `number`                      | No       | —       | Delay delivery by N seconds (0–900)                                     |
| message_attributes | `Record<string, {type, value}>` | No     | —       | Custom message attributes (`type`: "String", "Number", or "Binary")    |

**Returns:** `{ messageId, sequenceNumber?, md5OfMessageBody }`.

---

### `sqs_get_queue_attributes`

Retrieves attributes of an SQS queue — message counts, configuration, and ARN.

| Parameter   | Type                          | Required | Description                            |
|-------------|-------------------------------|----------|----------------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | Target AWS environment                 |
| queue_url   | `string`                      | Yes      | Full SQS queue URL                     |

**Returns:** Queue attributes including message counts, retention period, visibility timeout, FIFO status, and more.

---

## Authentication Errors

If any tool returns an authentication error, the agent will automatically suggest calling `aws_sso_login`. Once you approve the browser login, retry the original request.

## Migrating from v1 (cloudwatch-mcp-server)

If you're upgrading from the original `cloudwatch-mcp-server`:

1. **Env vars renamed** — shared variables now use the `AWS_` prefix:
   - `CW_REGION` → `AWS_REGION`
   - `CW_DEV_PROFILE` → `AWS_DEV_PROFILE`
   - `CW_STAGING_PROFILE` → `AWS_STAGING_PROFILE`
   - `CW_PROD_PROFILE` → `AWS_PROD_PROFILE`
   - `CW_PROJECT_CONFIG` → `AWS_PROJECT_CONFIG`

2. **Log group prefixes removed** — `CW_DEV_LOG_PREFIX`, `CW_STAGING_LOG_PREFIX`, and `CW_PROD_LOG_PREFIX` are no longer needed. Log groups in the project config now use full names instead of suffixes relative to a prefix.

3. **SSO tool renamed** — `cloudwatch_sso_login` → `aws_sso_login`.

4. **Project config filename** — rename the file from `aws.project.json` to `aws-mcp.json` and place it at the root of your project. The old name is still discovered for backward compatibility but emits a deprecation warning. With the new name, the server auto-discovers the file by walking up from its CWD to the enclosing git root, so the per-project `.cursor/mcp.json` (whose only job was to set `AWS_PROJECT_CONFIG=./aws.project.json`) is no longer needed and can be deleted. `AWS_PROJECT_CONFIG` still works as an explicit override if you need it.

5. **Project config field names** — the JSON file supports an optional `queues` array alongside `logGroups`. Each log group entry uses `logGroupName` (the full CloudWatch log group name), and each queue entry uses `queueName`. The legacy `suffix` and `name` fields are still accepted for backward compatibility but will emit deprecation warnings — these warnings appear in stderr at startup and are injected into tool descriptions so the agent can surface them.

6. **`cloudwatch_sample_logs` removed** — the tool was a thin wrapper around `cloudwatch_insights_query`. To inspect raw log entries, run `cloudwatch_insights_query` with a small `limit` (e.g. `fields @timestamp, @message | sort @timestamp desc | limit 5`) and a recent `start_time`.

7. **MCP config key** — consider renaming `"cloudwatch"` to `"aws"` in your `mcp.json`.
