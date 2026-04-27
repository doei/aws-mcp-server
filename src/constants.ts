import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

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

export const DEFAULT_LOG_GROUP_LIMIT = 50;
export const DEFAULT_LOG_STREAM_LIMIT = 20;
export const MAX_RESPONSE_LENGTH = 50_000;
export const SSO_LOGIN_TIMEOUT_MS = 120_000;
export const INSIGHTS_POLL_INTERVAL_MS = 2_000;
export const INSIGHTS_MAX_ATTEMPTS = 15;

export interface ProjectLogGroup {
  logGroupName: string;
  description: string;
}

export interface ProjectQueue {
  queueName: string;
  description: string;
}

export interface ProjectConfig {
  logGroups: ProjectLogGroup[];
  queues: ProjectQueue[];
}

interface LoadedProjectConfig {
  config: ProjectConfig | null;
  warnings: string[];
  discoveredPath: string | null;
  discoverySource: "env" | "auto" | null;
}

function parseLogGroupEntry(
  entry: unknown,
  warnings: string[]
): ProjectLogGroup | null {
  if (typeof entry !== "object" || entry === null) {
    warnings.push(`logGroups entry is not an object: ${JSON.stringify(entry)}`);
    return null;
  }

  const record = entry as Record<string, unknown>;
  const description = record.description;
  if (typeof description !== "string") {
    warnings.push(
      `logGroups entry missing string "description": ${JSON.stringify(entry)}`
    );
    return null;
  }

  if (typeof record.logGroupName === "string") {
    return { logGroupName: record.logGroupName, description };
  }

  if (typeof record.name === "string") {
    warnings.push(
      `logGroups entry uses deprecated "name" field — rename to "logGroupName" (value: "${record.name}")`
    );
    return { logGroupName: record.name, description };
  }

  if (typeof record.suffix === "string") {
    warnings.push(
      `logGroups entry uses legacy "suffix" field — rename to "logGroupName" (value: "${record.suffix}")`
    );
    return { logGroupName: record.suffix, description };
  }

  warnings.push(
    `logGroups entry missing "logGroupName": ${JSON.stringify(entry)}`
  );
  return null;
}

function parseQueueEntry(
  entry: unknown,
  warnings: string[]
): ProjectQueue | null {
  if (typeof entry !== "object" || entry === null) {
    warnings.push(`queues entry is not an object: ${JSON.stringify(entry)}`);
    return null;
  }

  const record = entry as Record<string, unknown>;
  const description = record.description;
  if (typeof description !== "string") {
    warnings.push(
      `queues entry missing string "description": ${JSON.stringify(entry)}`
    );
    return null;
  }

  if (typeof record.queueName === "string") {
    return { queueName: record.queueName, description };
  }

  if (typeof record.name === "string") {
    warnings.push(
      `queues entry uses deprecated "name" field — rename to "queueName" (value: "${record.name}")`
    );
    return { queueName: record.name, description };
  }

  warnings.push(`queues entry missing "queueName": ${JSON.stringify(entry)}`);
  return null;
}

/** Filenames searched for during auto-discovery, in priority order. */
const PROJECT_CONFIG_FILENAMES: Array<{ name: string; deprecated: boolean }> = [
  { name: "aws-mcp.json", deprecated: false },
  { name: "aws.project.json", deprecated: true },
];

interface DiscoveredConfig {
  path: string;
  source: "env" | "auto";
  deprecatedFilename: boolean;
}

/**
 * Walks up from the current working directory looking for a config file.
 * Stops at a git repository boundary or the filesystem root.
 */
function discoverProjectConfigFile(): DiscoveredConfig | null {
  let dir = process.cwd();
  while (true) {
    for (const candidate of PROJECT_CONFIG_FILENAMES) {
      const candidatePath = join(dir, candidate.name);
      if (existsSync(candidatePath)) {
        return {
          path: candidatePath,
          source: "auto",
          deprecatedFilename: candidate.deprecated,
        };
      }
    }

    if (existsSync(join(dir, ".git"))) return null;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveProjectConfigSource(): DiscoveredConfig | null {
  const envPath = process.env.AWS_PROJECT_CONFIG;
  if (envPath) {
    return {
      path: resolve(envPath),
      source: "env",
      deprecatedFilename: false,
    };
  }
  return discoverProjectConfigFile();
}

function loadProjectConfig(): LoadedProjectConfig {
  const discovered = resolveProjectConfigSource();
  if (!discovered) {
    return {
      config: null,
      warnings: [],
      discoveredPath: null,
      discoverySource: null,
    };
  }

  const resolvedPath = discovered.path;
  const warnings: string[] = [];

  if (discovered.deprecatedFilename) {
    warnings.push(
      `discovered config at "${resolvedPath}" — "aws.project.json" is deprecated, rename to "aws-mcp.json"`
    );
  }

  const baseResult = {
    discoveredPath: resolvedPath,
    discoverySource: discovered.source,
  };

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    warnings.push(
      `failed to read "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`
    );
    return { config: null, warnings, ...baseResult };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(
      `failed to parse "${resolvedPath}" as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    return { config: null, warnings, ...baseResult };
  }

  if (typeof parsed !== "object" || parsed === null) {
    warnings.push(
      `invalid format in "${resolvedPath}" — expected an object with optional "logGroups" and "queues" arrays`
    );
    return { config: null, warnings, ...baseResult };
  }

  const obj = parsed as Record<string, unknown>;

  const logGroups: ProjectLogGroup[] = [];
  if (Array.isArray(obj.logGroups)) {
    for (const entry of obj.logGroups) {
      const parsedEntry = parseLogGroupEntry(entry, warnings);
      if (parsedEntry) logGroups.push(parsedEntry);
    }
  } else if (obj.logGroups !== undefined) {
    warnings.push(`"logGroups" is not an array — ignoring`);
  }

  const queues: ProjectQueue[] = [];
  if (Array.isArray(obj.queues)) {
    for (const entry of obj.queues) {
      const parsedEntry = parseQueueEntry(entry, warnings);
      if (parsedEntry) queues.push(parsedEntry);
    }
  } else if (obj.queues !== undefined) {
    warnings.push(`"queues" is not an array — ignoring`);
  }

  return { config: { logGroups, queues }, warnings, ...baseResult };
}

const loaded = loadProjectConfig();

export const PROJECT_CONFIG = loaded.config;
export const PROJECT_CONFIG_WARNINGS = loaded.warnings;
export const PROJECT_CONFIG_PATH = loaded.discoveredPath;
export const PROJECT_CONFIG_SOURCE = loaded.discoverySource;

if (loaded.discoveredPath) {
  const sourceLabel =
    loaded.discoverySource === "env"
      ? "AWS_PROJECT_CONFIG env var"
      : "auto-discovered";
  console.error(
    `aws-mcp-server: project config loaded from "${loaded.discoveredPath}" (${sourceLabel})`
  );
} else {
  console.error(
    `aws-mcp-server: no project config found (searched cwd "${process.cwd()}" and parents up to git root for aws-mcp.json; set AWS_PROJECT_CONFIG to override)`
  );
}

if (loaded.warnings.length > 0) {
  console.error("=".repeat(60));
  console.error("aws-mcp-server: project config loaded with warnings:");
  for (const warning of loaded.warnings) {
    console.error(`  - ${warning}`);
  }
  console.error("=".repeat(60));
}

/**
 * Returns a warning block to inject into tool descriptions when
 * the project config had load issues. Visible to the agent so it can
 * surface problems to the user.
 */
export function projectConfigWarningsSection(): string {
  if (PROJECT_CONFIG_WARNINGS.length === 0) return "";
  const lines = PROJECT_CONFIG_WARNINGS.map((w) => `  - ${w}`);
  return `\n\nProject config warnings (surface these to the user if relevant):\n${lines.join("\n")}`;
}

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
