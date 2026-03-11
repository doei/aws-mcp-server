# cloudwatch-mcp-server

A local MCP server that connects AI agents (Cursor, Claude Desktop, etc.) to AWS CloudWatch Logs across multiple AWS accounts using SSO authentication.

## Features

- Query CloudWatch Logs across **dev**, **staging**, and **prod** environments
- AWS SSO authentication with profile-based credentials
- Five tools: SSO login, list log groups, list log streams, Insights queries, sample logs
- Query **multiple log groups in a single call** (up to 10)
- Accepts **ISO 8601 or Unix epoch seconds** for time ranges
- **Project config** to bake known log group names into tool descriptions automatically
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

Add the following to `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project):

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

## Project Config (Optional)

Set `CW_PROJECT_CONFIG` to the path of a JSON file that describes your project's log groups. When set, the MCP server reads this file at startup and bakes the log group names into tool descriptions — so agents know which log groups to query without a discovery round-trip.

**`cloudwatch.project.json`** (place in your project repo):

```json
{
  "logGroups": [
    { "suffix": "myapp", "description": "Main application logs" },
    { "suffix": "myapp/worker", "description": "Background worker logs" }
  ]
}
```

Suffixes are appended to the environment's log group prefix at runtime (e.g. `my-org/prod/myapp`).

**Per-project MCP config** (`.cursor/mcp.json` in the consuming repo):

Add this file alongside your existing global `~/.cursor/mcp.json`. You don't need to repeat the full server config — Cursor merges project-level and global config. Only the `env` block is needed to pass the extra variable:

```json
{
  "mcpServers": {
    "cloudwatch": {
      "env": {
        "CW_PROJECT_CONFIG": "/absolute/path/to/this/project/cloudwatch.project.json"
      }
    }
  }
}
```

If `CW_PROJECT_CONFIG` is not set, all tools work exactly as before.

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

## Authentication Errors

If any tool returns an authentication error, the agent will automatically suggest calling `cloudwatch_sso_login`. Once you approve the browser login, retry the original request.
