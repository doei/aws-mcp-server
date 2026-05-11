# aws-mcp-server

A local MCP server that connects AI agents (Cursor, Claude Desktop, etc.) to AWS services across multiple AWS accounts using SSO authentication.

## Features

- **CloudWatch Logs** — query logs across **dev**, **staging**, and **prod** environments
- **SQS** — list queues, send messages, inspect queue attributes
- AWS SSO authentication with profile-based credentials
- Seven tools: SSO login, list log groups, list log streams, Insights queries, list queues, send message, get queue attributes
- Query **multiple log groups in a single call** (up to 10)
- Accepts **ISO 8601 or Unix epoch seconds** for time ranges
- **Project config** (`aws-mcp.json` at your repo root) constrains tool input schemas to the project's known log groups and queues — agents pick the right resource on the first call
- The server requires `aws-mcp.json`; without it, every tool returns a clear "not configured" error
- SQS tools accept queue **names**; the server resolves the URL via the AWS profile's credentials, so callers never need the AWS account ID
- Automatic auth-error detection with helpful retry instructions
- Response truncation at 50,000 characters to keep context manageable

## Prerequisites

- Node.js 18+
- AWS CLI v2 with SSO configured (`aws configure sso`)
- AWS SSO profiles configured in `~/.aws/config`
- An MCP client that implements the `roots` capability (Cursor and VS Code do)

## Setup

```bash
cd aws-mcp-server
npm install
npm run build
```

## Cursor MCP Configuration

Add the following to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aws": {
      "command": "node",
      "args": ["/absolute/path/to/aws-mcp-server/dist/index.js"],
      "env": {
        "AWS_REGION": "eu-west-1",
        "AWS_DEV_PROFILE": "myorg-dev",
        "AWS_STAGING_PROFILE": "myorg-staging",
        "AWS_PROD_PROFILE": "myorg-prod"
      }
    }
  }
}
```

Replace `/absolute/path/to/aws-mcp-server` with the actual path on your system. Restart Cursor after saving `mcp.json`.

A single global registration is enough: the server picks up the right `aws-mcp.json` automatically based on the workspace each Cursor window is open in.

## Account & Profile Mapping

| Environment | Env Var               |
|-------------|-----------------------|
| dev         | `AWS_DEV_PROFILE`     |
| staging     | `AWS_STAGING_PROFILE` |
| prod        | `AWS_PROD_PROFILE`    |

| Env Var      | Description                                     |
|--------------|-------------------------------------------------|
| `AWS_REGION` | AWS region for all API calls (e.g. `eu-west-1`) |

The AWS account ID for each profile is resolved automatically from `~/.aws/config` (via the AWS SDK) and never has to be specified.

## Project Config

The server requires a single file named **`aws-mcp.json`** at the root of the project being worked in. It declares the log groups and queues the project cares about, and constrains the tools' input schemas to those values.

```json
{
  "logGroups": [
    { "logGroupName": "myorg/dev/myapp", "description": "Main application logs (dev)" },
    { "logGroupName": "myorg/prod/myapp", "description": "Main application logs (prod)" }
  ],
  "queues": [
    { "queueName": "order-processing-dev", "description": "Processes new orders (dev)" },
    { "queueName": "email-notifications-dev", "description": "Sends email notifications (dev)" }
  ]
}
```

### Discovery

On startup the server requests the workspace roots from the MCP client (`roots/list`) and walks up from each one looking for `aws-mcp.json`, stopping at a `.git` directory or the filesystem root. The first match wins.

`process.cwd()` is **not** consulted, and there is no environment-variable override. The client-reported workspace roots are the only source for "where is the project". If your client doesn't implement the `roots` capability, the server stays in not-configured mode (see below).

### Not-configured behavior

If no usable `aws-mcp.json` is found:

- The server still starts and registers all tools.
- Every tool returns a single, explicit text response telling the agent the server is not configured and how to fix it (`Add an aws-mcp.json file at the root of your project ...`). The agent can pass this through to the user.
- The server's `instructions` (returned during MCP initialize) explain the same requirement up front.

The server also emits a stderr line with the searched roots, visible in the client's MCP log.

### How the project config shapes the tools

Once the file is loaded:

- `sqs_send_message` and `sqs_get_queue_attributes` accept a `queue_name` parameter whose schema is a closed set of the project's queue names. Each accepted value carries its `description` from the file as the per-value schema description, so the agent sees, for each queue, both the canonical name and what it's for.
- `cloudwatch_list_log_streams` and `cloudwatch_insights_query` apply the same shape to `log_group_name` / `log_group_names`.
- `sqs_list_queues` and `cloudwatch_list_log_groups` remain available for genuine discovery — useful when the user references a resource that is not yet in `aws-mcp.json`.
- The `queues` and `logGroups` arrays are independent. If only one is provided, only the matching tools are enabled; the others stay in not-configured mode.

## Tools

### `aws_sso_login`

Initiates AWS SSO login for an environment, opening a browser window.

| Parameter   | Type                          | Required | Description            |
|-------------|-------------------------------|----------|------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | Target AWS environment |

**Usage note:** After calling this tool, the agent will prompt you to approve the login in your browser. Only retry your original request after confirming in the browser.

---

### `cloudwatch_list_log_groups`

Lists CloudWatch log groups with optional name-prefix filtering. Useful for genuine discovery; for project-declared log groups the other CloudWatch tools accept names directly.

| Parameter   | Type                          | Required | Default | Description                            |
|-------------|-------------------------------|----------|---------|----------------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                 |
| prefix      | `string`                      | No       | —       | Filter by log group name prefix        |
| limit       | `number`                      | No       | 50      | Maximum number of log groups to return |

**Returns:** Array of `{ logGroupName, retentionInDays }`.

---

### `cloudwatch_list_log_streams`

Lists log streams in a log group, most recently active first.

| Parameter      | Type                                       | Required | Default | Description                         |
|----------------|--------------------------------------------|----------|---------|-------------------------------------|
| environment    | `"dev" \| "staging" \| "prod"`              | Yes      | —       | Target AWS environment              |
| log_group_name | one of the project's `logGroups[].logGroupName` | Yes  | —       | Log group name from `aws-mcp.json`  |
| limit          | `number`                                   | No       | 20      | Maximum number of streams to return |

**Returns:** Array of `{ logStreamName, lastEventTime }`.

---

### `cloudwatch_insights_query`

Runs a CloudWatch Logs Insights query and polls for results. Supports querying multiple log groups in a single call.

| Parameter       | Type                                                                 | Required | Default | Description                                            |
|-----------------|----------------------------------------------------------------------|----------|---------|--------------------------------------------------------|
| environment     | `"dev" \| "staging" \| "prod"`                                        | Yes      | —       | Target AWS environment                                 |
| log_group_names | one of the project's `logGroups[].logGroupName`, or array of up to 10 | Yes      | —       | Log group name(s) from `aws-mcp.json`                  |
| query           | `string`                                                             | Yes      | —       | Logs Insights query string                             |
| start_time      | `string \| number`                                                   | Yes      | —       | ISO 8601 string or Unix epoch seconds                  |
| end_time        | `string \| number`                                                   | No       | now     | ISO 8601 string or Unix epoch seconds                  |

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

### `sqs_list_queues`

Lists SQS queues in the specified environment. Useful for genuine discovery; for project-declared queues the other SQS tools accept names directly.

| Parameter   | Type                          | Required | Default | Description                        |
|-------------|-------------------------------|----------|---------|------------------------------------|
| environment | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment             |
| prefix      | `string`                      | No       | —       | Filter queues by name prefix       |
| limit       | `number`                      | No       | 50      | Maximum number of queues to return |

**Returns:** Array of `{ queueUrl, queueName }`.

---

### `sqs_send_message`

Sends a message to an SQS queue. Supports standard and FIFO queues, message attributes, and delayed delivery.

| Parameter          | Type                                          | Required | Default | Description                                                     |
|--------------------|-----------------------------------------------|----------|---------|-----------------------------------------------------------------|
| environment        | `"dev" \| "staging" \| "prod"`                  | Yes      | —       | Target AWS environment                                          |
| queue_name         | one of the project's `queues[].queueName`     | Yes      | —       | Queue name from `aws-mcp.json`                                  |
| message_body       | `string`                                      | Yes      | —       | Message content (plain text or JSON)                            |
| message_group_id   | `string`                                      | No       | —       | Message group ID (required for FIFO queues)                     |
| deduplication_id   | `string`                                      | No       | —       | Deduplication token (required for FIFO without content-based)   |
| delay_seconds      | `number`                                      | No       | —       | Delay delivery by N seconds (0–900)                             |
| message_attributes | `Record<string, {type, value}>`               | No       | —       | Custom message attributes (`type`: "String", "Number", "Binary") |

**Returns:** `{ messageId, sequenceNumber?, md5OfMessageBody }`.

The server resolves the queue name to its full URL via `GetQueueUrl` against the configured profile's credentials, and caches the result for the lifetime of the process. The cache is invalidated by `aws_sso_login`.

---

### `sqs_get_queue_attributes`

Retrieves attributes of an SQS queue — message counts, configuration, and ARN.

| Parameter   | Type                                          | Required | Description                    |
|-------------|-----------------------------------------------|----------|--------------------------------|
| environment | `"dev" \| "staging" \| "prod"`                 | Yes      | Target AWS environment         |
| queue_name  | one of the project's `queues[].queueName`     | Yes      | Queue name from `aws-mcp.json` |

**Returns:** Queue attributes including message counts, retention period, visibility timeout, FIFO status, ARN, and more.

---

## Authentication Errors

If any tool returns an authentication error, the agent will automatically suggest calling `aws_sso_login`. Once you approve the browser login, retry the original request.
