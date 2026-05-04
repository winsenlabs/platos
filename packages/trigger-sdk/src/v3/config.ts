import type { TriggerConfig } from "@platos/core/v3";

export type {
  HandleErrorArgs,
  HandleErrorFunction,
  ResolveEnvironmentVariablesFunction,
  ResolveEnvironmentVariablesParams,
  ResolveEnvironmentVariablesResult,
} from "@platos/core/v3";

export function defineConfig(config: TriggerConfig): TriggerConfig {
  return config;
}

export type { TriggerConfig };
