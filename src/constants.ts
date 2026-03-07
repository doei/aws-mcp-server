const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const REGION = requiredEnv("CW_REGION");

export const PROFILES: Record<Environment, string> = {
  dev: requiredEnv("CW_DEV_PROFILE"),
  staging: requiredEnv("CW_STAGING_PROFILE"),
  prod: requiredEnv("CW_PROD_PROFILE"),
};

export const LOG_PREFIXES: Record<Environment, string> = {
  dev: requiredEnv("CW_DEV_LOG_PREFIX"),
  staging: requiredEnv("CW_STAGING_LOG_PREFIX"),
  prod: requiredEnv("CW_PROD_LOG_PREFIX"),
};

export const DEFAULT_TIME_WINDOW_MINUTES = 60;
export const DEFAULT_LOG_GROUP_LIMIT = 50;
export const DEFAULT_LOG_STREAM_LIMIT = 20;
export const MAX_RESPONSE_LENGTH = 50_000;
export const SSO_LOGIN_TIMEOUT_MS = 120_000;
export const INSIGHTS_POLL_INTERVAL_MS = 2_000;
export const INSIGHTS_MAX_ATTEMPTS = 15;
