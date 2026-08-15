import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { CLOUD_API_URL } from "../consts.js";
import { readAuthConfigProfile } from "../utilities/configFiles.js";
import { NotAccessTokenError, validateAccessToken } from "../utilities/accessTokens.js";
import { LoginResult, LoginResultOk } from "../utilities/session.js";
import { McpContext } from "./context.js";
import { ApiClient } from "@platos/core/v3";

export type McpAuthOptions = {
  server: McpServer;
  context: McpContext;
  defaultApiUrl?: string;
  profile?: string;
};

export async function mcpAuth(options: McpAuthOptions): Promise<LoginResult> {
  const opts = {
    defaultApiUrl: CLOUD_API_URL,
    ...options,
  };

  const accessTokenFromEnv = env.TRIGGER_ACCESS_TOKEN;

  if (accessTokenFromEnv) {
    const validationResult = validateAccessToken(accessTokenFromEnv);

    if (!validationResult.success) {
      // We deliberately don't surface the existence of organization access tokens to the user for now, as they're only used internally.
      // Once we expose them in the application, we should also communicate that option here.
      throw new NotAccessTokenError(
        "TRIGGER_ACCESS_TOKEN must be a Platos API token starting with 'plt_pat_'. Generate one at /account/api-tokens."
      );
    }

    const auth = {
      accessToken: accessTokenFromEnv,
      apiUrl: env.TRIGGER_API_URL ?? opts.defaultApiUrl ?? CLOUD_API_URL,
    };

    const apiClient = new CliApiClient(auth.apiUrl, auth.accessToken);
    const userData = await apiClient.whoAmI();

    if (!userData.success) {
      throw new Error(userData.error);
    }

    return {
      ok: true as const,
      profile: options?.profile ?? "default",
      userId: userData.data.userId,
      email: userData.data.email,
      dashboardUrl: userData.data.dashboardUrl,
      auth: {
        accessToken: auth.accessToken,
        apiUrl: auth.apiUrl,
        tokenType: validationResult.type,
      },
    };
  }

  const authConfig = readAuthConfigProfile(options?.profile);

  if (authConfig && authConfig.accessToken) {
    const apiClient = new CliApiClient(
      authConfig.apiUrl ?? opts.defaultApiUrl,
      authConfig.accessToken
    );
    const userData = await apiClient.whoAmI();

    if (!userData.success) {
      throw new Error(userData.error);
    }

    return {
      ok: true as const,
      profile: options?.profile ?? "default",
      userId: userData.data.userId,
      email: userData.data.email,
      dashboardUrl: userData.data.dashboardUrl,
      auth: {
        accessToken: authConfig.accessToken,
        apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
        tokenType: "personal" as const,
      },
    };
  }

  return {
    ok: false as const,
    error:
      "Authentication requires a Platos API token. Run `trigger.dev login --access-token plt_pat_...` or set TRIGGER_ACCESS_TOKEN.",
  };
}

export async function createApiClientWithPublicJWT(
  auth: LoginResultOk,
  projectRef: string,
  envName: string,
  scopes: string[],
  previewBranch?: string
) {
  const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken, previewBranch);

  const jwt = await cliApiClient.getJWT(projectRef, envName, {
    claims: {
      scopes,
    },
  });

  if (!jwt.success) {
    return;
  }

  return new ApiClient(auth.auth.apiUrl, jwt.data.token);
}
