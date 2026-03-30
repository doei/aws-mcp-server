# aws-mcp-server

A local MCP server that connects AI agents (Cursor, Claude Desktop, etc.) to AWS services across multiple AWS accounts using SSO authentication.

## Features

- **CloudWatch Logs** — query logs across **dev**, **staging**, and **prod** environments
- **SQS** — list queues, send messages, inspect queue attributes
- AWS SSO authentication with profile-based credentials
- Eight tools: SSO login, list log groups, list log streams, Insights queries, sample logs, list queues, send message, get queue attributes
- Query **multiple log groups in a single call** (up to 10)
- Accepts **ISO 8601 or Unix epoch seconds** for time ranges
- **Project config** to bake known log group names and queue names into tool descriptions
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
| `AWS_REGION`         | AWS region for all API calls (e.g. `us-east-1`)    |
| `CW_DEV_LOG_PREFIX`  | CloudWatch log group prefix for dev environment    |
| `CW_STAGING_LOG_PREFIX` | CloudWatch log group prefix for staging         |
| `CW_PROD_LOG_PREFIX` | CloudWatch log group prefix for prod environment   |

## Project Config (Optional)

Set `AWS_PROJECT_CONFIG` to the path of a JSON file that describes your project's log groups and queues. When set, the MCP server reads this file at startup and bakes the names into tool descriptions — so agents know which resources to use without a discovery round-trip.

**`aws.project.json`** (place in your project repo):

```json
{
  "logGroups": [
    { "suffix": "myapp", "description": "Main application logs" },
    { "suffix": "myapp/worker", "description": "Background worker logs" }
  ],
  "queues": [
    { "name": "order-processing", "description": "Processes new orders" },
    { "name": "email-notifications", "description": "Sends email notifications" }
  ]
}
```

Log group suffixes are appended to the environment's log group prefix at runtime (e.g. `my-org/prod/myapp`). Queue names appear in SQS tool descriptions for agent discoverability.

**Per-project MCP config** (`.cursor/mcp.json` in the consuming repo):

Add this file alongside your existing global `~/.cursor/mcp.json`. You don't need to repeat the full server config — Cursor merges project-level and global config. Only the `env` block is needed to pass the extra variable:

```json
{
  "mcpServers": {
    "aws": {
      "env": {
        "AWS_PROJECT_CONFIG": "./aws.project.json"
      }
    }
  }
}
```

`AWS_PROJECT_CONFIG` can be a relative or absolute path. Relative paths are resolved against the MCP server process's working directory, which Cursor sets to the workspace root when launching from a per-project `.cursor/mcp.json` — so `./aws.project.json` refers to a file at the root of your project.

If `AWS_PROJECT_CONFIG` is not set, all tools work exactly as before.

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
| suffix      | `string`                      | No       | —       | Filter by log group name suffix          |
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
fields @timestamp, @message | filter @message like /(?i)error/ | sort @timestamp desc | limit 50
fields @timestamp, @message | filter someField = "value" | sort @timestamp desc | limit 50
stats count(*) by someField | sort count(*) desc
fields @timestamp, requestId, duration | filter duration > 1000 | sort duration desc
```

---

### `cloudwatch_sample_logs`

Fetches a small number of recent log entries from one or more log groups. Use this to discover what structured fields are available before writing a targeted `cloudwatch_insights_query`.

| Parameter       | Type                          | Required | Default | Description                                         |
|-----------------|-------------------------------|----------|---------|-----------------------------------------------------|
| environment     | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                              |
| log_group_names | `string \| string[]`          | Yes      | —       | Log group name or array of up to 10 log group names |
| minutes         | `number`                      | No       | 60      | How many minutes back to look                       |
| limit           | `number`                      | No       | 5       | Number of entries to return (max 20)                |

**Returns:** Array of recent log entries with `@timestamp` and `@message` fields.

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
   - CloudWatch-specific vars (`CW_DEV_LOG_PREFIX`, etc.) are unchanged.

2. **SSO tool renamed** — `cloudwatch_sso_login` → `aws_sso_login`.

3. **Project config** — the JSON file now supports an optional `queues` array alongside `logGroups`. Existing configs with only `logGroups` continue to work.

4. **MCP config key** — consider renaming `"cloudwatch"` to `"aws"` in your `mcp.json`.
