import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  Environment,
  MAX_RESPONSE_LENGTH,
  PROFILES,
  REGION,
} from "../constants.js";

const clientCache = new Map<string, CloudWatchLogsClient>();

export function getClientForEnv(env: Environment): CloudWatchLogsClient {
  const profile = PROFILES[env];
  const cached = clientCache.get(profile);
  if (cached) return cached;

  const client = new CloudWatchLogsClient({
    region: REGION,
    credentials: fromIni({ profile }),
  });
  clientCache.set(profile, client);
  return client;
}

export function clearClientCache(): void {
  clientCache.clear();
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
