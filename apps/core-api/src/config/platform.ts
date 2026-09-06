// THE WHOLE STARTUP CONFIGURATION, VALIDATED IN ONE PASS.
//
// Six sections: core (schema.ts), stores, providers, channels, durable runtime
// and security. This module runs the group engine over the five sibling sections,
// runs `loadCoreApiConfiguration` over the first, and returns either one frozen
// typed value or every diagnostic from all six at once.
//
// ALL SIX, THEN REPORT — NOT FIRST FAILURE, AND NOT FIRST SECTION. `load.ts`
// already collects within a section for a stated reason: five restarts to
// discover five bad variables is a worse outage than the misconfiguration. That
// argument does not stop at a section boundary, so a core failure does not
// suppress the store diagnostics, and a store failure does not suppress the
// security ones. One start, one list, every variable named.
//
// ---------------------------------------------------------------------------
// THE GROUP ENGINE, AND THE THREE WAYS A GROUP CAN BE WRONG
//
// A group is DECLARED when its anchor is present. From there:
//
//   INCOMPLETE — the anchor is present and a `requiredWithAnchor` field is not.
//   This is the case "required or default" schemes cannot express: a ClickHouse
//   URL with no database name, an object endpoint with no credentials, a durable
//   endpoint with no key. Each of those boots today and fails at first use.
//
//   ORPHANED — the anchor is absent and some member of the group is present.
//   This is the SILENT one, and it is why the engine has anchors at all. Setting
//   `PLATOS_STORE_OBJECT_BUCKET` and forgetting the endpoint validates under
//   every scheme that treats fields independently: the value is well-formed, so
//   nothing complains, the adapter is never constructed, and the operator's
//   belief that the store is wired survives until the first upload. Naming it as
//   an error is the difference between a startup failure and a support ticket.
//
//   MALFORMED — an ordinary field failure, decided by `validateField`, whether
//   the group is declared or not. A group nobody declared can still be told that
//   the one variable they did set is not a URL.
//
// A GROUP THAT IS ABSENT IS NOT AN ERROR. This process must boot with no store
// wired at all: readiness reports the unsatisfied bindings, which is the honest
// answer for an install part-way through wiring, and `process.test.ts` proves the
// built binary serves on `PLATOS_ENVIRONMENT` alone. That property is what stops
// this section from being a list of variables everyone sets to a placeholder.
// ---------------------------------------------------------------------------

import { assembleChannels, CHANNELS_SECTION, type ChannelsConfiguration } from "./channels.js";
import {
  assembleDurableRuntime,
  DURABLE_RUNTIME_SECTION,
  type DurableRuntimeSectionConfiguration,
} from "./durable-runtime.js";
import {
  loadCoreApiConfiguration,
  validateField,
  type ConfigDiagnostic,
  type EnvironmentSource,
} from "./load.js";
import { assembleProviders, PROVIDERS_SECTION, type ProvidersConfiguration } from "./providers.js";
import { groupFields, type ConfigGroupSpec, type ConfigSectionSpec, type CoreApiConfiguration } from "./schema.js";
import { assembleSecurity, SECURITY_SECTION, type SecurityConfiguration } from "./security.js";
import { assembleStores, STORES_SECTION, type StoresConfiguration } from "./stores.js";

/** Every section spec, in the order their diagnostics are reported. */
export const PLATFORM_SECTIONS: readonly ConfigSectionSpec[] = Object.freeze([
  STORES_SECTION,
  PROVIDERS_SECTION,
  CHANNELS_SECTION,
  DURABLE_RUNTIME_SECTION,
  SECURITY_SECTION,
]);

/** The validated whole. `core` is always present; a section's groups may be null. */
export interface PlatformConfiguration {
  readonly core: CoreApiConfiguration;
  readonly stores: StoresConfiguration;
  readonly providers: ProvidersConfiguration;
  readonly channels: ChannelsConfiguration;
  readonly durable: DurableRuntimeSectionConfiguration;
  readonly security: SecurityConfiguration;
  /** Which groups this install declared, section-qualified: `stores.postgres`. */
  readonly declaredGroups: readonly string[];
}

export type PlatformOutcome =
  | { readonly ok: true; readonly value: PlatformConfiguration }
  | { readonly ok: false; readonly diagnostics: readonly ConfigDiagnostic[] };

/** Is a raw environment value present at all? Blank is absent — see `validateField`. */
function present(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}

interface GroupOutcome {
  readonly declared: boolean;
  readonly resolved: ReadonlyMap<string, string | null>;
}

function evaluateGroup(
  section: ConfigSectionSpec,
  group: ConfigGroupSpec,
  env: EnvironmentSource,
  diagnostics: ConfigDiagnostic[],
): GroupOutcome {
  const resolved = new Map<string, string | null>();
  const declared = present(env[group.anchor.name]);

  // Every field is validated whether or not the group is declared. A malformed
  // value in an undeclared group is still a mistake worth naming, and validating
  // only declared groups would mean a typo hides behind the typo beside it.
  for (const field of groupFields(group)) {
    resolved.set(field.name, validateField(field, env[field.name], diagnostics));
  }

  if (declared) {
    for (const field of group.requiredWithAnchor) {
      if (present(env[field.name])) continue;
      diagnostics.push({
        field: field.name,
        problem:
          `is required once ${group.anchor.name} is set` +
          ` (${section.id}.${group.id}: ${group.describe}; ${field.describe})`,
        shownValue: null,
        presented: "absent",
        redacted: field.secret,
      });
    }
    return { declared, resolved };
  }

  for (const field of [...group.requiredWithAnchor, ...group.optional]) {
    if (!present(env[field.name])) continue;
    diagnostics.push({
      field: field.name,
      problem:
        `is set but ${group.anchor.name} is not, so nothing reads it` +
        ` (${section.id}.${group.id}: ${group.describe})`,
      // The ORPHANED case never echoes a value even for a non-secret field. The
      // complaint is about presence, not content, and an operator who mistyped a
      // variable name does not need the value read back to find the mistake.
      shownValue: null,
      presented: "present",
      redacted: field.secret,
    });
  }
  return { declared, resolved };
}

/**
 * Validate every section and assemble the whole configuration.
 *
 * Pure over `env`. The one process-environment read in V1 feature code is
 * `readProcessEnvironment()` in `environment.ts`; everything from there down,
 * including this function, is a function over an ordinary object.
 */
export function loadPlatformConfiguration(env: EnvironmentSource): PlatformOutcome {
  const diagnostics: ConfigDiagnostic[] = [];

  const core = loadCoreApiConfiguration(env);
  if (!core.ok) diagnostics.push(...core.diagnostics);

  const resolved = new Map<string, string | null>();
  const declaredGroups: string[] = [];
  const declaredIds = new Set<string>();

  for (const section of PLATFORM_SECTIONS) {
    for (const group of section.groups) {
      const outcome = evaluateGroup(section, group, env, diagnostics);
      for (const [name, value] of outcome.resolved) resolved.set(name, value);
      if (!outcome.declared) continue;
      declaredGroups.push(`${section.id}.${group.id}`);
      declaredIds.add(`${section.id}.${group.id}`);
    }
  }

  if (diagnostics.length > 0 || !core.ok) return { ok: false, diagnostics };

  const read = (name: string): string | null => resolved.get(name) ?? null;
  const declaredIn =
    (sectionId: string) =>
    (groupId: string): boolean =>
      declaredIds.has(`${sectionId}.${groupId}`);

  return {
    ok: true,
    value: Object.freeze({
      core: core.value,
      stores: assembleStores(read, declaredIn("stores")),
      providers: assembleProviders(read, declaredIn("providers")),
      channels: assembleChannels(read, declaredIn("channels")),
      durable: assembleDurableRuntime(read, declaredIn("durableRuntime")),
      security: assembleSecurity(read, declaredIn("security")),
      declaredGroups: Object.freeze([...declaredGroups]),
    }),
  };
}

/** Every variable name the six sections declare, in section then group order. */
export function platformFieldNames(): readonly string[] {
  const names: string[] = [];
  for (const section of PLATFORM_SECTIONS) {
    for (const group of section.groups) {
      for (const field of groupFields(group)) names.push(field.name);
    }
  }
  return Object.freeze(names);
}
