import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  Environment,
  MAX_RESPONSE_LENGTH,
  PROFILES,
  REGION,
} from "../constants.js";

const cwClientCache = new Map<string, CloudWatchLogsClient>();
const sqsClientCache = new Map<string, SQSClient>();
const queueUrlCache = new Map<string, string>();

export function getCloudWatchClientForEnv(env: Environment): CloudWatchLogsClient {
  const profile = PROFILES[env];
  const cached = cwClientCache.get(profile);
  if (cached) return cached;

  const client = new CloudWatchLogsClient({
    region: REGION,
    credentials: fromIni({ profile }),
  });
  cwClientCache.set(profile, client);
  return client;
}

export function getSqsClientForEnv(env: Environment): SQSClient {
  const profile = PROFILES[env];
  const cached = sqsClientCache.get(profile);
  if (cached) return cached;

  const client = new SQSClient({
    region: REGION,
    credentials: fromIni({ profile }),
  });
  sqsClientCache.set(profile, client);
  return client;
}

/**
 * Resolves an SQS queue name to its full queue URL using the AWS SDK.
 * The URL is derived from the AWS profile's credentials (account, partition, region),
 * so the agent never needs to know the account ID. Results are cached per
 * (environment, name) for the lifetime of the process.
 */
export async function resolveQueueUrl(
  env: Environment,
  queueName: string
): Promise<string> {
  const cacheKey = `${env}:${queueName}`;
  const cached = queueUrlCache.get(cacheKey);
  if (cached) return cached;

  const client = getSqsClientForEnv(env);
  const response = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName })
  );
  const url = response.QueueUrl;
  if (!url) {
    throw new Error(
      `GetQueueUrl returned no QueueUrl for "${queueName}" in environment "${env}"`
    );
  }
  queueUrlCache.set(cacheKey, url);
  return url;
}

export function clearClientCache(): void {
  cwClientCache.clear();
  sqsClientCache.clear();
  queueUrlCache.clear();
}

export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const name = (error as { name?: string }).name ?? "";
  const message = error.message.toLowerCase();

  const authErrorNames = new Set([
    "TokenProviderError",
    "ExpiredTokenException",
    "UnauthorizedException",
    "AccessDeniedException",
    "CredentialsProviderError",
    "InvalidIdentityTokenException",
  ]);

  if (authErrorNames.has(name)) return true;

  const authSubstrings = [
    "no credentials",
    "sso",
    "token",
    "expired",
    "not authorized",
    "credentials",
    "authentication",
    "could not load credentials",
  ];

  return authSubstrings.some((s) => message.includes(s));
}

export function truncateResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_LENGTH) return text;
  const omitted = text.length - MAX_RESPONSE_LENGTH;
  return (
    text.slice(0, MAX_RESPONSE_LENGTH) +
    `\n\n[Response truncated. ${omitted.toLocaleString()} characters omitted.]`
  );
}
