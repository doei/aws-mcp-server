import { readFileSync } from "fs";

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

export const DEFAULT_LOG_GROUP_LIMIT = 50;
export const DEFAULT_LOG_STREAM_LIMIT = 20;
export const MAX_RESPONSE_LENGTH = 50_000;
export const SSO_LOGIN_TIMEOUT_MS = 120_000;
export const INSIGHTS_POLL_INTERVAL_MS = 2_000;
export const INSIGHTS_MAX_ATTEMPTS = 15;

export interface ProjectLogGroup {
  suffix: string;
  description: string;
}

export interface ProjectConfig {
  logGroups: ProjectLogGroup[];
}

function loadProjectConfig(): ProjectConfig | null {
  const configPath = process.env.CW_PROJECT_CONFIG;
  if (!configPath) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { logGroups?: unknown }).logGroups)
    ) {
      console.error(
        `CW_PROJECT_CONFIG: invalid format in "${configPath}" — expected { logGroups: [{ suffix, description }] }`
      );
      return null;
    }

    const config = parsed as { logGroups: unknown[] };
    const logGroups: ProjectLogGroup[] = [];
    for (const entry of config.logGroups) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { suffix?: unknown }).suffix === "string" &&
        typeof (entry as { description?: unknown }).description === "string"
      ) {
        logGroups.push(entry as ProjectLogGroup);
      } else {
        console.error(
          `CW_PROJECT_CONFIG: skipping invalid logGroups entry in "${configPath}":`,
          entry
        );
      }
    }

    return { logGroups };
  } catch (err) {
    console.error(`CW_PROJECT_CONFIG: failed to load "${configPath}":`, err);
    return null;
  }
}

export const PROJECT_CONFIG = loadProjectConfig();

const CLOUDWATCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#E7157B"/>
  <path d="M10 34 L17 24 L22 28 L28 18 L34 22 L38 14" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38" cy="14" r="2.5" fill="#fff"/>
</svg>`;

export const CLOUDWATCH_ICONS = [
  {
    src: `data:image/svg+xml;base64,${Buffer.from(CLOUDWATCH_ICON_SVG).toString("base64")}`,
    mimeType: "image/svg+xml" as const,
    sizes: ["48x48"],
  },
];
