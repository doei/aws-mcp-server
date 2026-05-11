import {
  ListQueuesCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodTypeAny } from "zod";
import {
  type Environment,
  PROFILES,
  type ProjectConfig,
  type ProjectQueue,
  notConfiguredMessage,
} from "../constants.js";
import {
  getSqsClientForEnv,
  isAuthError,
  resolveQueueUrl,
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

function notConfiguredResponse() {
  return {
    content: [
      {
        type: "text" as const,
        text: notConfiguredMessage(),
      },
    ],
  };
}

/**
 * Builds a schema accepting only the queue names declared in the project config.
 * Each accepted value carries its `description` from `aws-mcp.json`, so the
 * agent sees per-value documentation in the tool's input schema.
 *
 * Returns null if there are no queues — the caller should leave the tool disabled.
 */
function buildQueueNameSchema(queues: ProjectQueue[]): ZodTypeAny | null {
  if (queues.length === 0) return null;
  if (queues.length === 1) {
    const [q] = queues;
    return z.literal(q.queueName).describe(q.description);
  }
  const literals = queues.map((q) =>
    z.literal(q.queueName).describe(q.description)
  );
  return z.union(
    literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]
  );
}

const SQS_LIST_DESCRIPTION = `Lists SQS queues in the specified AWS environment.

Use this tool to discover queues that aren't declared in the project's aws-mcp.json. For project-declared queues, prefer calling sqs_send_message or sqs_get_queue_attributes directly with the queue name.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- prefix (optional): Filter queues whose names begin with this prefix.
- limit (optional, default 50): Maximum number of queues to return.

Returns:
A JSON array of objects with fields:
- queueUrl (string): The full URL of the queue.
- queueName (string): The queue name extracted from the URL.`;

const SQS_SEND_DESCRIPTION = `Sends a message to an SQS queue in the specified AWS environment.

The queue is addressed by name. The server resolves the URL via the configured AWS profile's credentials, so callers do not need to know the AWS account ID or queue URL.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- queue_name (required): Name of the queue. The accepted values are constrained by the project's aws-mcp.json.
- message_body (required): The message content to send. Plain text or JSON.
- message_group_id (optional): Required for FIFO queues.
- deduplication_id (optional): Required for FIFO queues without content-based deduplication.
- delay_seconds (optional): Delay delivery by N seconds (0–900).
- message_attributes (optional): Custom message attributes as key-value pairs, each with a type ("String", "Number", "Binary") and a value.

Returns:
A JSON object with the message ID and, for FIFO queues, the sequence number.`;

const SQS_ATTRS_DESCRIPTION = `Retrieves attributes of an SQS queue — message counts, configuration, and ARN.

The queue is addressed by name. The server resolves the URL via the configured AWS profile's credentials.

Parameters:
- environment (required): AWS environment — "dev", "staging", or "prod".
- queue_name (required): Name of the queue. The accepted values are constrained by the project's aws-mcp.json.

Returns:
A JSON object with queue attributes including:
- ApproximateNumberOfMessages, ApproximateNumberOfMessagesNotVisible, ApproximateNumberOfMessagesDelayed
- MessageRetentionPeriod, VisibilityTimeout, FifoQueue
- QueueArn
- And more.`;

export interface SqsToolsRegistration {
  applyConfig(config: ProjectConfig): void;
}

export function registerSqsTools(server: McpServer): SqsToolsRegistration {
  // Pre-register tools in a "not configured" state. The schemas use a permissive
  // string for queue_name and the handlers short-circuit. Once the project config
  // is loaded (after roots/list), `applyConfig` updates each tool's schema and handler.
  const placeholderQueueName = z
    .string()
    .describe("Queue name (constrained once aws-mcp.json is loaded)");

  const listQueues = server.registerTool(
    "sqs_list_queues",
    {
      title: "List SQS Queues",
      description: SQS_LIST_DESCRIPTION,
      inputSchema: {
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
      },
    },
    async () => notConfiguredResponse()
  );

  const sendMessage = server.registerTool(
    "sqs_send_message",
    {
      title: "Send SQS Message",
      description: SQS_SEND_DESCRIPTION,
      inputSchema: {
        environment: environmentSchema,
        queue_name: placeholderQueueName,
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
          .describe(
            "Deduplication token (required for FIFO queues without content-based deduplication)"
          ),
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
              type: z
                .enum(["String", "Number", "Binary"])
                .describe("Attribute data type"),
              value: z.string().describe("Attribute value"),
            })
          )
          .optional()
          .describe("Custom message attributes as key-value pairs"),
      },
    },
    async () => notConfiguredResponse()
  );

  const getQueueAttributes = server.registerTool(
    "sqs_get_queue_attributes",
    {
      title: "Get SQS Queue Attributes",
      description: SQS_ATTRS_DESCRIPTION,
      inputSchema: {
        environment: environmentSchema,
        queue_name: placeholderQueueName,
      },
    },
    async () => notConfiguredResponse()
  );

  return {
    applyConfig(config: ProjectConfig) {
      const queueNameSchema = buildQueueNameSchema(config.queues);
      if (!queueNameSchema) {
        // No queues declared — keep the SQS tools in their not-configured state.
        // sqs_list_queues stays disabled too: the project file decided not to
        // expose any SQS surface for this project.
        return;
      }

      listQueues.update({
        callback: async ({ environment, prefix, limit }) => {
          const env = environment as Environment;
          const client = getSqsClientForEnv(env);
          try {
            const response = await client.send(
              new ListQueuesCommand({
                QueueNamePrefix: prefix as string | undefined,
                MaxResults: limit as number,
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
        },
      });

      sendMessage.update({
        paramsSchema: {
          environment: environmentSchema,
          queue_name: queueNameSchema,
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
            .describe(
              "Deduplication token (required for FIFO queues without content-based deduplication)"
            ),
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
                type: z
                  .enum(["String", "Number", "Binary"])
                  .describe("Attribute data type"),
                value: z.string().describe("Attribute value"),
              })
            )
            .optional()
            .describe("Custom message attributes as key-value pairs"),
        },
        callback: async (args: Record<string, unknown>) => {
          const env = args.environment as Environment;
          const queueName = args.queue_name as string;
          const messageBody = args.message_body as string;
          const messageGroupId = args.message_group_id as string | undefined;
          const deduplicationId = args.deduplication_id as string | undefined;
          const delaySeconds = args.delay_seconds as number | undefined;
          const attrs = args.message_attributes as
            | Record<string, { type: string; value: string }>
            | undefined;

          try {
            const queueUrl = await resolveQueueUrl(env, queueName);
            const client = getSqsClientForEnv(env);
            const sqsAttributes:
              | Record<string, { DataType: string; StringValue: string }>
              | undefined = attrs
              ? Object.fromEntries(
                  Object.entries(attrs).map(([key, attr]) => [
                    key,
                    { DataType: attr.type, StringValue: attr.value },
                  ])
                )
              : undefined;

            const response = await client.send(
              new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: messageBody,
                MessageGroupId: messageGroupId,
                MessageDeduplicationId: deduplicationId,
                DelaySeconds: delaySeconds,
                MessageAttributes: sqsAttributes,
              })
            );

            const result = {
              messageId: response.MessageId,
              ...(response.SequenceNumber && {
                sequenceNumber: response.SequenceNumber,
              }),
              ...(response.MD5OfMessageBody && {
                md5OfMessageBody: response.MD5OfMessageBody,
              }),
            };
            const text = JSON.stringify(result, null, 2);
            return { content: [{ type: "text", text }] };
          } catch (error) {
            if (isAuthError(error)) return authErrorResponse(env);
            throw error;
          }
        },
      });

      getQueueAttributes.update({
        paramsSchema: {
          environment: environmentSchema,
          queue_name: queueNameSchema,
        },
        callback: async (args: Record<string, unknown>) => {
          const env = args.environment as Environment;
          const queueName = args.queue_name as string;
          try {
            const queueUrl = await resolveQueueUrl(env, queueName);
            const client = getSqsClientForEnv(env);
            const response = await client.send(
              new GetQueueAttributesCommand({
                QueueUrl: queueUrl,
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
        },
      });
    },
  };
}
