# cloudwatch-mcp-server

A local MCP server that connects AI agents (Cursor, Claude Desktop, etc.) to AWS CloudWatch Logs across multiple AWS accounts using SSO authentication.

## Features

- Query CloudWatch Logs across **dev**, **staging**, and **prod** environments
- AWS SSO authentication with profile-based credentials
- Five tools: SSO login, list log groups, list log streams, search logs, Insights queries
- Automatic auth-error detection with helpful retry instructions
- Response truncation at 50,000 characters to keep context manageable

## Prerequisites

- Node.js 18+
- AWS CLI v2 with SSO configured (`aws configure sso`)
- AWS SSO profiles configured in `~/.aws/config` (see Account & Profile Mapping below)

## Setup

```bash
cd cloudwatch-mcp-server
npm install
npm run build
```

## Cursor MCP Configuration

Add the following to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cloudwatch": {
      "command": "node",
      "args": ["/absolute/path/to/cloudwatch-mcp-server/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/cloudwatch-mcp-server` with the actual path on your system (e.g. `/Users/yourname/cloudwatch-mcp-server`).

Restart Cursor after saving `mcp.json`.

## Account & Profile Mapping

| Environment | Env Var              |
|-------------|----------------------|
| dev         | `CW_DEV_PROFILE`     |
| staging     | `CW_STAGING_PROFILE` |
| prod        | `CW_PROD_PROFILE`    |

Set these environment variables to your AWS SSO profile names (e.g. `export CW_DEV_PROFILE=myorg-dev`).

## Tools

### `cloudwatch_sso_login`

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

### `cloudwatch_search_logs`

Searches log events using a CloudWatch filter pattern.

| Parameter      | Type                          | Required | Default | Description                                      |
|----------------|-------------------------------|----------|---------|--------------------------------------------------|
| environment    | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                           |
| log_group_name | `string`                      | Yes      | —       | Full log group name                              |
| filter_pattern | `string`                      | No       | —       | CloudWatch filter pattern (e.g. `"ERROR"`)       |
| minutes_ago    | `number`                      | No       | 60      | Look back this many minutes (max 1440)           |
| limit          | `number`                      | No       | 50      | Maximum events to return (max 100)               |
| log_stream_name| `string`                      | No       | —       | Restrict to a single stream                      |

**Returns:** Array of `{ timestamp, message, logStreamName }`.

---

### `cloudwatch_insights_query`

Runs a CloudWatch Logs Insights query and polls for results.

| Parameter      | Type                          | Required | Default | Description                                      |
|----------------|-------------------------------|----------|---------|--------------------------------------------------|
| environment    | `"dev" \| "staging" \| "prod"` | Yes      | —       | Target AWS environment                           |
| log_group_name | `string`                      | Yes      | —       | Full log group name                              |
| query          | `string`                      | Yes      | —       | Logs Insights query string                       |
| minutes_ago    | `number`                      | No       | 60      | Query this many minutes of history               |

**Returns:** Array of result row objects, or a "still running" message with the query ID.

**Example queries:**
```
fields @timestamp, @message | sort @timestamp desc | limit 20
stats count(*) by bin(5m) | sort bin(5m) desc
filter @message like /ERROR/ | stats count() by level
```

## Authentication Errors

If any tool returns an authentication error, the agent will automatically suggest calling `cloudwatch_sso_login`. Once you approve the browser login, retry the original request.
