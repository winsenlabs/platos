import { type ApiClientConfiguration, apiClientManager } from "@platos/core/v3";

/**
 * Register the global API client configuration. Alternatively, set the
 * `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL` environment variables.
 *
 * @param options The API client configuration.
 * @param options.baseURL The base URL of the Trigger API.
 * @param options.accessToken The access token used to authenticate API requests.
 *
 * @example
 *
 * ```typescript
 * import { configure } from "@platos/sdk/v3";
 *
 * configure({
 *   baseURL: "https://api.trigger.dev",
 *   accessToken: "tr_dev_1234567890",
 * });
 * ```
 */
export function configure(options: ApiClientConfiguration) {
  apiClientManager.setGlobalAPIClientConfiguration(options);
}

export const auth = {
  configure,
  withAuth,
};

/**
 * Execute an asynchronous function with a scoped API client configuration.
 */
async function withAuth<R extends (...args: any[]) => Promise<any>>(
  config: ApiClientConfiguration,
  fn: R
): Promise<ReturnType<R>> {
  return apiClientManager.runWithConfig(config, fn);
}
