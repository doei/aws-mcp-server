import {
  ListQueuesCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Environment,
  PROFILES,
  PROJECT_CONFIG,
} from "../constants.js";
import {
  getSqsClientForEnv,
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
        text: `Authentication failed for environment "${env}". Please call the aws_sso_login tool with environment "${env}" to refresh credentials, then retry this request.`,
      },
    ],
  };
}

function projectQueuesSection(): string {
  if (!PROJECT_CONFIG || PROJECT_CONFIG.queues.length === 0) return "";
  const lines = PROJECT_CONFIG.queues.map(
    (q) => `  - ${q.name} — ${q.description}`
  );
  return `\n\nKnown queues for this project:\n${lines.join("\n")}`;
}

export function registerSqsTools(server: McpServer): void {
  server.registerTool(
    "sqs_list_queues",
    {
      title: "List SQS Queues",
      description: `Lists SQS queues in the specified AWS environment.

Use this tool to discover available queues and their URLs before sending messages.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- prefix (optional): Filter queues whose names begin with this prefix.
- limit (optional, default 50): Maximum number of queues to return.${projectQueuesSection()}

Returns:
A JSON array of objects with fields:
- queueUrl (string): The full URL of the queue.
- queueName (string): The queue name extracted from the URL.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          prefix: z
            .string()
            .optional()
            .describe("Filter queues whose names begin with this prefix"),
          limit: z
            .number()
            .int()
            .positive()
            .default(50)
            .describe("Maximum queues to return (default 50)"),
        })
        .strict(),
    },
    async ({ environment, prefix, limit }) => {
      const env = environment as Environment;
      const client = getSqsClientForEnv(env);
      try {
        const response = await client.send(
          new ListQueuesCommand({
            QueueNamePrefix: prefix,
            MaxResults: limit,
          })
        );

        const queues = (response.QueueUrls ?? []).map((url) => ({
          queueUrl: url,
          queueName: url.split("/").pop() ?? url,
        }));

        const text = truncateResponse(JSON.stringify(queues, null, 2));
        return { content: [{ type: "text", text }] };
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );

  server.registerTool(
    "sqs_send_message",
    {
      title: "Send SQS Message",
      description: `Sends a message to an SQS queue in the specified AWS environment.

Use sqs_list_queues first to discover queue URLs if needed.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- queue_url (required): Full SQS queue URL (e.g. "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue").
- message_body (required): The message content to send. Can be plain text or JSON.
- message_group_id (optional): Required for FIFO queues. Tag that specifies the message belongs to a specific group.
- deduplication_id (optional): Token for deduplication of sent messages. Required for FIFO queues without content-based deduplication.
- delay_seconds (optional): Delay delivery of the message by this many seconds (0–900).
- message_attributes (optional): Key-value pairs of custom message attributes. Each attribute needs a type ("String", "Number", or "Binary") and a value.${projectQueuesSection()}

Returns:
A JSON object with the message ID and, for FIFO queues, the sequence number.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          queue_url: z
            .string()
            .url()
            .describe("Full SQS queue URL"),
          message_body: z
            .string()
            .describe("Message content to send (plain text or JSON)"),
          message_group_id: z
            .string()
            .optional()
            .describe("Message group ID (required for FIFO queues)"),
          deduplication_id: z
            .string()
            .optional()
            .describe("Deduplication token (required for FIFO queues without content-based deduplication)"),
          delay_seconds: z
            .number()
            .int()
            .min(0)
            .max(900)
            .optional()
            .describe("Delay delivery by N seconds (0–900)"),
          message_attributes: z
            .record(
              z.string(),
              z.object({
                type: z.enum(["String", "Number", "Binary"]).describe("Attribute data type"),
                value: z.string().describe("Attribute value"),
              })
            )
            .optional()
            .describe("Custom message attributes as key-value pairs"),
        })
        .strict(),
    },
    async ({
      environment,
      queue_url,
      message_body,
      message_group_id,
      deduplication_id,
      delay_seconds,
      message_attributes,
    }) => {
      const env = environment as Environment;
      const client = getSqsClientForEnv(env);
      try {
        const sqsAttributes: Record<string, { DataType: string; StringValue: string }> | undefined =
          message_attributes
            ? Object.fromEntries(
                Object.entries(message_attributes).map(([key, attr]) => [
                  key,
                  { DataType: attr.type, StringValue: attr.value },
                ])
              )
            : undefined;

        const response = await client.send(
          new SendMessageCommand({
            QueueUrl: queue_url,
            MessageBody: message_body,
            MessageGroupId: message_group_id,
            MessageDeduplicationId: deduplication_id,
            DelaySeconds: delay_seconds,
            MessageAttributes: sqsAttributes,
          })
        );

        const result = {
          messageId: response.MessageId,
          ...(response.SequenceNumber && { sequenceNumber: response.SequenceNumber }),
          ...(response.MD5OfMessageBody && { md5OfMessageBody: response.MD5OfMessageBody }),
        };

        const text = JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );

  server.registerTool(
    "sqs_get_queue_attributes",
    {
      title: "Get SQS Queue Attributes",
      description: `Retrieves attributes of an SQS queue — message counts, configuration, and ARN.

Useful for checking if a queue has messages waiting, its retention policy, or whether it's a FIFO queue.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- queue_url (required): Full SQS queue URL.${projectQueuesSection()}

Returns:
A JSON object with queue attributes including:
- ApproximateNumberOfMessages: Messages available for retrieval.
- ApproximateNumberOfMessagesNotVisible: Messages in flight.
- ApproximateNumberOfMessagesDelayed: Messages delayed.
- MessageRetentionPeriod: How long messages are retained (seconds).
- VisibilityTimeout: Default visibility timeout (seconds).
- FifoQueue: Whether this is a FIFO queue.
- And more.`,
      inputSchema: z
        .object({
          environment: environmentSchema,
          queue_url: z
            .string()
            .url()
            .describe("Full SQS queue URL"),
        })
        .strict(),
    },
    async ({ environment, queue_url }) => {
      const env = environment as Environment;
      const client = getSqsClientForEnv(env);
      try {
        const response = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queue_url,
            AttributeNames: ["All"],
          })
        );

        const text = truncateResponse(
          JSON.stringify(response.Attributes ?? {}, null, 2)
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        if (isAuthError(error)) return authErrorResponse(env);
        throw error;
      }
    }
  );
}
