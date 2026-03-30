import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  Environment,
  MAX_RESPONSE_LENGTH,
  PROFILES,
  REGION,
} from "../constants.js";

const cwClientCache = new Map<string, CloudWatchLogsClient>();
const sqsClientCache = new Map<string, SQSClient>();

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

export function clearClientCache(): void {
  cwClientCache.clear();
  sqsClientCache.clear();
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
