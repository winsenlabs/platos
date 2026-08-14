export type ExternalTriggerConfig =
  | { status: "disabled" }
  | {
      status: "incomplete";
      message: string;
      endpoint?: string;
    }
  | {
      status: "configured";
      endpoint: string;
      accessToken: string;
    };

/**
 * Resolve the optional external Trigger.dev connection used by non-worker
 * agent runtime paths. There is deliberately no Cloud or Platos-webapp
 * fallback: an operator must name the external endpoint explicitly.
 */
export function resolveExternalTriggerConfig(
  source: NodeJS.ProcessEnv = process.env,
): ExternalTriggerConfig {
  const endpoint = source.TRIGGER_API_URL?.trim();
  const accessToken = source.TRIGGER_SECRET_KEY?.trim();

  if (!endpoint && !accessToken) return { status: "disabled" };

  if (!endpoint) {
    return {
      status: "incomplete",
      message:
        "TRIGGER_SECRET_KEY is set but TRIGGER_API_URL is missing; external Trigger is disabled and turns will dispatch direct.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return {
      status: "incomplete",
      endpoint,
      message:
        "TRIGGER_API_URL is not a valid URL; external Trigger is disabled and turns will dispatch direct.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      status: "incomplete",
      endpoint,
      message:
        "TRIGGER_API_URL must use http or https; external Trigger is disabled and turns will dispatch direct.",
    };
  }

  if (!accessToken) {
    return {
      status: "incomplete",
      endpoint,
      message:
        "TRIGGER_API_URL is set but TRIGGER_SECRET_KEY is missing; durable Trigger dispatch is disabled and turns will dispatch direct.",
    };
  }

  return { status: "configured", endpoint, accessToken };
}

export function configureExternalTriggerSdk(
  sdk: { configure?: (options: { accessToken: string; baseURL: string }) => unknown } | null,
  source: NodeJS.ProcessEnv = process.env,
): ExternalTriggerConfig {
  const config = resolveExternalTriggerConfig(source);
  if (config.status === "configured" && sdk?.configure) {
    sdk.configure({ accessToken: config.accessToken, baseURL: config.endpoint });
  }
  return config;
}

/**
 * Per-environment API clients obtain their token from RuntimeEnvironment, but
 * they still require the same explicit external endpoint.
 */
export function resolveExternalTriggerEndpoint(
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  const endpoint = source.TRIGGER_API_URL?.trim();
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? endpoint : null;
  } catch {
    return null;
  }
}
