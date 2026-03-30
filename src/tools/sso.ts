import { execSync } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Environment, PROFILES, SSO_LOGIN_TIMEOUT_MS } from "../constants.js";
import { clearClientCache } from "../services/aws.js";

export function registerSsoTools(server: McpServer): void {
  server.registerTool(
    "aws_sso_login",
    {
      title: "AWS SSO Login",
      description: `Initiates AWS SSO login for the specified environment, opening a browser window for the user to authenticate.

Use this tool when any AWS tool returns an authentication error, or when credentials appear to be expired or missing.

**Important agent instructions:**
1. Call this tool with the affected environment.
2. IMMEDIATELY inform the user: "A browser window has opened for AWS SSO login. Please approve the request in your browser, then let me know when you're done."
3. Do NOT retry the original AWS tool until the user explicitly confirms they have completed the browser login.
4. Once the user confirms, retry the original tool.

Parameters:
- environment (required): One of "dev", "staging", or "prod". ${Object.entries(PROFILES).map(([env, profile]) => `"${env}" uses profile "${profile}"`).join("; ")}.`,
      inputSchema: z
        .object({
          environment: z.enum(["dev", "staging", "prod"]).describe(
            Object.entries(PROFILES)
              .map(([env, profile]) => `"${env}" → "${profile}"`)
              .join(", ")
          ),
        })
        .strict(),
    },
    ({ environment }) => {
      const profile = PROFILES[environment as Environment];
      try {
        execSync(`aws sso login --profile ${profile}`, {
          stdio: "inherit",
          timeout: SSO_LOGIN_TIMEOUT_MS,
        });
        clearClientCache();
        return {
          content: [
            {
              type: "text",
              text: `SSO login completed for profile "${profile}" (environment: ${environment}). Client cache has been cleared.\n\nPlease tell the user: "Browser login was successful. You can now retry your request."`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `SSO login failed for profile "${profile}" (environment: ${environment}): ${message}\n\nPlease tell the user that SSO login failed and ask them to try again.`,
            },
          ],
        };
      }
    }
  );
}
