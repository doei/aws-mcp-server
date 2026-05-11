import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ProjectConfig, ProjectLogGroup, ProjectQueue } from "./constants.js";

const PROJECT_CONFIG_FILENAMES: Array<{ name: string; deprecated: boolean }> = [
  { name: "aws-mcp.json", deprecated: false },
  { name: "aws.project.json", deprecated: true },
];

export interface LoadedProjectConfig {
  config: ProjectConfig | null;
  warnings: string[];
  discoveredPath: string | null;
  searchedRoots: string[];
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

/** Walks up from `dir` looking for a config file. Stops at a `.git` boundary or the filesystem root. */
function findConfigFile(
  dir: string
): { path: string; deprecatedFilename: boolean } | null {
  let current = dir;
  while (true) {
    for (const candidate of PROJECT_CONFIG_FILENAMES) {
      const candidatePath = join(current, candidate.name);
      if (existsSync(candidatePath)) {
        return { path: candidatePath, deprecatedFilename: candidate.deprecated };
      }
    }

    if (existsSync(join(current, ".git"))) return null;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function rootUriToPath(uri: string): string | null {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    if (uri.startsWith("/")) return uri;
    return null;
  } catch {
    return null;
  }
}

/**
 * Walks up from each provided root looking for an `aws-mcp.json` file.
 * Returns the first match's parsed contents, plus parse warnings.
 *
 * The server has no other source for "where is the project?" — the
 * client's reported workspace roots are the only signal used.
 */
export function loadProjectConfigFromRoots(
  rootUris: string[]
): LoadedProjectConfig {
  const searchedRoots: string[] = [];
  for (const uri of rootUris) {
    const path = rootUriToPath(uri);
    if (!path) continue;
    searchedRoots.push(path);
  }

  for (const root of searchedRoots) {
    const found = findConfigFile(root);
    if (!found) continue;
    return readAndParse(found.path, found.deprecatedFilename, searchedRoots);
  }

  return {
    config: null,
    warnings: [],
    discoveredPath: null,
    searchedRoots,
  };
}

function readAndParse(
  resolvedPath: string,
  deprecatedFilename: boolean,
  searchedRoots: string[]
): LoadedProjectConfig {
  const warnings: string[] = [];

  if (deprecatedFilename) {
    warnings.push(
      `discovered config at "${resolvedPath}" — "aws.project.json" is deprecated, rename to "aws-mcp.json"`
    );
  }

  const baseResult = { discoveredPath: resolvedPath, searchedRoots };

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
