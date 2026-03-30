import { readFileSync } from "fs";
import { resolve } from "path";

const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const REGION = requiredEnv("AWS_REGION");

export const PROFILES: Record<Environment, string> = {
  dev: requiredEnv("AWS_DEV_PROFILE"),
  staging: requiredEnv("AWS_STAGING_PROFILE"),
  prod: requiredEnv("AWS_PROD_PROFILE"),
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

export interface ProjectQueue {
  name: string;
  description: string;
}

export interface ProjectConfig {
  logGroups: ProjectLogGroup[];
  queues: ProjectQueue[];
}

function loadProjectConfig(): ProjectConfig | null {
  const configPath = process.env.AWS_PROJECT_CONFIG;
  if (!configPath) return null;

  const resolvedPath = resolve(configPath);
  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      console.error(
        `AWS_PROJECT_CONFIG: invalid format in "${resolvedPath}" — expected { logGroups?: [...], queues?: [...] }`
      );
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    const logGroups: ProjectLogGroup[] = [];
    if (Array.isArray(obj.logGroups)) {
      for (const entry of obj.logGroups) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { suffix?: unknown }).suffix === "string" &&
          typeof (entry as { description?: unknown }).description === "string"
        ) {
          logGroups.push(entry as ProjectLogGroup);
        } else {
          console.error(
            `AWS_PROJECT_CONFIG: skipping invalid logGroups entry in "${resolvedPath}":`,
            entry
          );
        }
      }
    }

    const queues: ProjectQueue[] = [];
    if (Array.isArray(obj.queues)) {
      for (const entry of obj.queues) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { name?: unknown }).name === "string" &&
          typeof (entry as { description?: unknown }).description === "string"
        ) {
          queues.push(entry as ProjectQueue);
        } else {
          console.error(
            `AWS_PROJECT_CONFIG: skipping invalid queues entry in "${resolvedPath}":`,
            entry
          );
        }
      }
    }

    return { logGroups, queues };
  } catch (err) {
    console.error(`AWS_PROJECT_CONFIG: failed to load "${resolvedPath}":`, err);
    return null;
  }
}

export const PROJECT_CONFIG = loadProjectConfig();

function svgToIconEntry(svg: string) {
  return [
    {
      src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      mimeType: "image/svg+xml" as const,
      sizes: ["48x48"],
    },
  ];
}

const CLOUDWATCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#E7157B"/>
  <path d="M10 34 L17 24 L22 28 L28 18 L34 22 L38 14" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="38" cy="14" r="2.5" fill="#fff"/>
</svg>`;

const SQS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#E7157B"/>
  <path d="M14 16h20v4H14zM14 24h20v4H14zM14 32h20v4H14z" fill="#fff" opacity="0.9"/>
  <path d="M10 14v24l4-2V16z" fill="#fff" opacity="0.6"/>
  <path d="M38 14v24l-4-2V16z" fill="#fff" opacity="0.6"/>
</svg>`;

const AWS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#232F3E"/>
  <path d="M15 28c0 0 3 4 9 4s9-4 9-4" stroke="#FF9900" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <path d="M34 28l3 2-3 2" stroke="#FF9900" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16 20c0 0 2-4 8-4s8 4 8 4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;

export const CLOUDWATCH_ICONS = svgToIconEntry(CLOUDWATCH_ICON_SVG);
export const SQS_ICONS = svgToIconEntry(SQS_ICON_SVG);
export const AWS_ICONS = svgToIconEntry(AWS_ICON_SVG);
