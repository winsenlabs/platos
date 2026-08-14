import { intro, log, outro, select } from "@clack/prompts";
import { recordSpanException } from "@platos/core/v3/workers";
import { Command } from "commander";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import {
  CommonCommandOptions,
  SkipLoggingError,
  commonOptions,
  handleTelemetry,
  tracer,
  wrapCommandAction,
} from "../cli/common.js";
import { prettyError } from "../utilities/cliOutput.js";
import {
  readAuthConfigProfile,
  writeAuthConfigProfile,
  writeAuthConfigCurrentProfileName,
} from "../utilities/configFiles.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { LoginResult } from "../utilities/session.js";
import { whoAmI } from "./whoami.js";
import { logger } from "../utilities/logger.js";
import { VERSION } from "../version.js";
import { env, isCI } from "std-env";
import { CLOUD_API_URL } from "../consts.js";
import {
  validateAccessToken,
  NotAccessTokenError,
} from "../utilities/accessTokens.js";
import { links } from "@platos/core/v3";

export const LoginCommandOptions = CommonCommandOptions.extend({
  apiUrl: z.string(),
  accessToken: z.string().optional(),
});

export type LoginCommandOptions = z.infer<typeof LoginCommandOptions>;

export function configureLoginCommand(program: Command) {
  return commonOptions(
    program
      .command("login")
      .description("Login with a Platos API token so you can perform authenticated actions")
      .option("--access-token <token>", "A Platos API token starting with plt_pat_")
  )
    .version(VERSION, "-v, --version", "Display the version number")
    .action(async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await loginCommand(options);
      });
    });
}

export async function loginCommand(options: unknown) {
  return await wrapCommandAction("loginCommand", LoginCommandOptions, options, async (opts) => {
    return await _loginCommand(opts);
  });
}

async function _loginCommand(options: LoginCommandOptions) {
  return login({
    defaultApiUrl: options.apiUrl,
    embedded: false,
    profile: options.profile,
    accessToken: options.accessToken,
  });
}

export type LoginOptions = {
  defaultApiUrl?: string;
  embedded?: boolean;
  profile?: string;
  silent?: boolean;
  accessToken?: string;
};

export async function login(options?: LoginOptions): Promise<LoginResult> {
  return await tracer.startActiveSpan("login", async (span) => {
    try {
      const opts = {
        defaultApiUrl: CLOUD_API_URL,
        embedded: false,
        silent: false,
        ...options,
      };

      span.setAttributes({
        "cli.config.apiUrl": opts.defaultApiUrl,
        "cli.options.profile": opts.profile,
      });

      if (!opts.embedded) {
        intro("Logging in to Trigger.dev");
      }

      const accessTokenFromEnv = opts.accessToken ?? env.TRIGGER_ACCESS_TOKEN;

      if (accessTokenFromEnv) {
        const validationResult = validateAccessToken(accessTokenFromEnv);

        if (!validationResult.success) {
          // We deliberately don't surface the existence of organization access tokens to the user for now, as they're only used internally.
          // Once we expose them in the application, we should also communicate that option here.
          throw new NotAccessTokenError(
            "The access token must be a Platos API token starting with 'plt_pat_'. Generate one at /account/api-tokens."
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

        if (opts.accessToken) {
          const profileName = options?.profile ?? "default";
          writeAuthConfigProfile(auth, options?.profile);
          writeAuthConfigCurrentProfileName(profileName);
        }

        return {
          ok: true as const,
          profile: options?.profile ?? "default",
          userId: userData.data.userId,
          email: userData.data.email,
          dashboardUrl: userData.data.dashboardUrl,
          auth: {
            accessToken: auth.accessToken,
            tokenType: validationResult.type,
            apiUrl: auth.apiUrl,
          },
        };
      }

      const authConfig = readAuthConfigProfile(options?.profile);

      if (authConfig && authConfig.accessToken) {
        const whoAmIResult = await whoAmI(
          {
            profile: options?.profile ?? "default",
            skipTelemetry: !span.isRecording(),
            logLevel: logger.loggerLevel,
          },
          true,
          opts.silent
        );

        if (!whoAmIResult.success) {
          prettyError("Unable to validate existing personal access token", whoAmIResult.error);

          if (!opts.embedded) {
            outro(
              `Login failed using stored token. To fix, first logout using \`trigger.dev logout${
                options?.profile ? ` --profile ${options.profile}` : ""
              }\` and then try again.`
            );

            throw new SkipLoggingError(whoAmIResult.error);
          } else {
            throw new Error(whoAmIResult.error);
          }
        } else {
          if (!opts.embedded) {
            const continueOption = await select({
              message: "You are already logged in.",
              options: [
                {
                  value: false,
                  label: "Exit",
                },
                {
                  value: true,
                  label: "Login with a different account",
                },
              ],
              initialValue: false,
            });

            if (continueOption !== true) {
              outro("Already logged in");

              span.setAttributes({
                "cli.userId": whoAmIResult.data.userId,
                "cli.email": whoAmIResult.data.email,
                "cli.config.apiUrl": authConfig.apiUrl ?? opts.defaultApiUrl,
              });

              span.end();

              return {
                ok: true as const,
                profile: options?.profile ?? "default",
                userId: whoAmIResult.data.userId,
                email: whoAmIResult.data.email,
                dashboardUrl: whoAmIResult.data.dashboardUrl,
                auth: {
                  accessToken: authConfig.accessToken,
                  apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
                  tokenType: "personal" as const,
                },
              };
            }
          } else {
            span.setAttributes({
              "cli.userId": whoAmIResult.data.userId,
              "cli.email": whoAmIResult.data.email,
              "cli.config.apiUrl": authConfig.apiUrl ?? opts.defaultApiUrl,
            });

            span.end();

            return {
              ok: true as const,
              profile: options?.profile ?? "default",
              userId: whoAmIResult.data.userId,
              email: whoAmIResult.data.email,
              dashboardUrl: whoAmIResult.data.dashboardUrl,
              auth: {
                accessToken: authConfig.accessToken,
                apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
                tokenType: "personal" as const,
              },
            };
          }
        }
      }

      if (isCI) {
        const apiUrl =
          env.TRIGGER_API_URL ?? authConfig?.apiUrl ?? opts.defaultApiUrl ?? CLOUD_API_URL;

        const isSelfHosted = apiUrl !== CLOUD_API_URL;

        // This is fine, as the api URL will generally be the same as the dashboard URL for self-hosted instances
        const dashboardUrl = isSelfHosted ? apiUrl : "https://cloud.trigger.dev";

        throw new Error(
          `Authentication required in CI environment. Set TRIGGER_ACCESS_TOKEN to a Platos API token beginning with plt_pat_.

- You can generate one here: ${dashboardUrl}/account/api-tokens

- For more information, see: ${links.docs.gitHubActions.personalAccessToken}`
        );
      }

      if (opts.embedded) {
        log.step("You must login to continue.");
      }

      const apiUrl = authConfig?.apiUrl ?? opts.defaultApiUrl ?? CLOUD_API_URL;
      const dashboardUrl = apiUrl === CLOUD_API_URL ? "https://cloud.trigger.dev" : apiUrl;
      throw new SkipLoggingError(
        `Authentication requires a Platos API token. Generate one at ${dashboardUrl}/account/api-tokens, then run \`trigger.dev login --access-token plt_pat_...\` or set TRIGGER_ACCESS_TOKEN.`
      );
    } catch (e) {
      recordSpanException(span, e);
      span.end();

      if (options?.embedded) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      throw e;
    }
  });
}
