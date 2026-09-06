// Startup configuration loading and validation — FAIL CLOSED.
//
// The contract this module keeps is narrow and absolute: if the configuration is
// missing or invalid, the process does not start, the diagnostic names every
// problem at once, and no secret value appears anywhere in it.
//
// COLLECT, DON'T THROW ON FIRST. An operator restarting a container five times
// to discover five bad variables is a worse outage than the misconfiguration.
// Validation gathers every failure and reports them together.
//
// The diagnostic is rendered by this module rather than by the caller, so the
// redaction decision is made once, next to the schema flag that drives it.

import {
  CORE_API_CONFIG_FIELDS,
  type ConfigFieldSpec,
  type CoreApiConfiguration,
  type CoreApiLogLevel,
  type PlatosEnvironment,
} from "./schema.js";

export interface ConfigDiagnostic {
  readonly field: string;
  /** What is wrong, in operator language. Never contains a value. */
  readonly problem: string;
  /**
   * The offending value, or null. Null when the field is absent AND when the
   * field is a secret — the two cases are distinguished by `presented`, so a
   * reader can tell "you did not set this" from "what you set is wrong but I
   * will not repeat it back to you".
   */
  readonly shownValue: string | null;
  readonly presented: "absent" | "present";
  readonly redacted: boolean;
}

export type ConfigOutcome =
  | { readonly ok: true; readonly value: CoreApiConfiguration }
  | { readonly ok: false; readonly diagnostics: readonly ConfigDiagnostic[] };

/** Longest value echoed into a diagnostic. A megabyte variable is not a message. */
const MAX_ECHOED_VALUE_LENGTH = 64;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

/**
 * Make a non-secret value safe to put in a log line.
 *
 * Control characters are stripped rather than escaped: a CR/LF inside a value an
 * attacker controls is log-forging, and a forged line in a structured log is
 * indistinguishable from a real one after the fact.
 */
function renderable(value: string): string {
  const stripped = value.replace(CONTROL_CHARACTERS, "\u{FFFD}");
  return stripped.length > MAX_ECHOED_VALUE_LENGTH
    ? `${stripped.slice(0, MAX_ECHOED_VALUE_LENGTH)}…`
    : stripped;
}

function diagnostic(field: ConfigFieldSpec, problem: string, raw: string | undefined): ConfigDiagnostic {
  const presented = raw === undefined ? "absent" : "present";
  const shownValue = raw === undefined || field.secret ? null : renderable(raw);
  return { field: field.name, problem, shownValue, presented, redacted: field.secret };
}

/**
 * Validate ONE field against ONE raw value.
 *
 * Exported because WIN-260's five sibling sections use it. They must: two
 * validators that agree today are a census that can drift, and this programme
 * has been bitten by that shape before. A section declares FIELDS; how a field
 * fails is decided here, once.
 *
 * Returns the resolved string (a default when absent and not required, `null`
 * when it failed) and pushes a diagnostic per failure rather than throwing —
 * see COLLECT, DON'T THROW ON FIRST above.
 */
export function validateField(
  field: ConfigFieldSpec,
  raw: string | undefined,
  diagnostics: ConfigDiagnostic[],
): string | null {
  const supplied = raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
  if (supplied === undefined) {
    if (field.required) {
      diagnostics.push(diagnostic(field, `is required (${field.describe})`, raw));
      return null;
    }
    return field.defaultValue;
  }

  if (field.kind === "enum") {
    const allowed = field.allowed ?? [];
    if (!allowed.includes(supplied)) {
      diagnostics.push(diagnostic(field, `must be one of ${allowed.join(", ")}`, raw));
      return null;
    }
    return supplied;
  }

  if (field.kind === "integer") {
    // Deliberately strict. `parseInt` accepts "8080abc" and "0x1f", which is how
    // a typo becomes a listener on a port nobody expected.
    if (!/^-?\d+$/u.test(supplied)) {
      diagnostics.push(diagnostic(field, "must be a base-10 integer", raw));
      return null;
    }
    const parsed = Number(supplied);
    const minimum = field.minimum ?? Number.MIN_SAFE_INTEGER;
    const maximum = field.maximum ?? Number.MAX_SAFE_INTEGER;
    if (parsed < minimum || parsed > maximum) {
      diagnostics.push(diagnostic(field, `must be between ${minimum} and ${maximum}`, raw));
      return null;
    }
    return supplied;
  }

  if (field.kind === "boolean") {
    // Exactly two spellings. "yes", "1", "on" and "TRUE" are all things an
    // operator reasonably types and all things a hand-rolled truthiness check
    // reads differently, so the set is closed and the failure names both members.
    if (supplied !== "true" && supplied !== "false") {
      diagnostics.push(diagnostic(field, "must be exactly true or false", raw));
      return null;
    }
    return supplied;
  }

  if (field.kind === "url") {
    // `URL` is the parser the runtime itself uses, so a value this accepts is a
    // value the client built from it will accept. A hand-written regex here
    // would be a second, weaker definition of the same word.
    let parsed: URL;
    try {
      parsed = new URL(supplied);
    } catch {
      diagnostics.push(diagnostic(field, "must be an absolute URL with a scheme", raw));
      return null;
    }
    const schemes = field.schemes ?? [];
    if (schemes.length > 0 && !schemes.includes(parsed.protocol)) {
      diagnostics.push(diagnostic(field, `must use one of the schemes ${schemes.join(", ")}`, raw));
      return null;
    }
    return supplied;
  }

  const minimumLength = field.minimumLength ?? 0;
  if (supplied.length < minimumLength) {
    diagnostics.push(diagnostic(field, `must be at least ${minimumLength} characters`, raw));
    return null;
  }
  if (field.pattern !== undefined) {
    // Anchored HERE rather than in the spec. A spec that anchored itself could
    // ship an unanchored pattern by omission, and a prefix match on an
    // encryption key is the difference between 64 hex characters and 64 hex
    // characters followed by anything at all.
    const whole = new RegExp(`^(?:${field.pattern})$`, "u");
    if (!whole.test(supplied)) {
      diagnostics.push(diagnostic(field, `must be ${field.patternDescribe ?? "in the accepted form"}`, raw));
      return null;
    }
  }
  return supplied;
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function loadCoreApiConfiguration(env: EnvironmentSource): ConfigOutcome {
  const diagnostics: ConfigDiagnostic[] = [];
  const resolved = new Map<string, string | null>();
  for (const field of CORE_API_CONFIG_FIELDS) {
    resolved.set(field.name, validateField(field, env[field.name], diagnostics));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const read = (name: string): string => {
    const value = resolved.get(name);
    // Unreachable: a null survives only alongside a diagnostic, and we returned.
    if (value === null || value === undefined) throw new Error(`configuration field ${name} resolved to nothing`);
    return value;
  };

  return {
    ok: true,
    value: Object.freeze({
      environment: read("PLATOS_ENVIRONMENT") as PlatosEnvironment,
      host: read("PLATOS_CORE_API_HOST"),
      port: Number(read("PLATOS_CORE_API_PORT")),
      shutdownTimeoutMs: Number(read("PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS")),
      drainGraceMs: Number(read("PLATOS_CORE_API_DRAIN_GRACE_MS")),
      requestIdHeader: read("PLATOS_CORE_API_REQUEST_ID_HEADER").toLowerCase(),
      logLevel: read("PLATOS_LOG_LEVEL") as CoreApiLogLevel,
      adminHealthToken: resolved.get("PLATOS_CORE_API_ADMIN_HEALTH_TOKEN") ?? null,
    }),
  };
}

/**
 * The operator-facing failure text.
 *
 * One line per problem, each naming the variable and what is wrong with it. A
 * secret's value is replaced by `[redacted]` and is not present in the returned
 * string in any form — `load.test.ts` asserts that against a real secret value
 * rather than against the absence of the word.
 */
export function renderStartupFailure(diagnostics: readonly ConfigDiagnostic[]): string {
  const lines = [
    "core-api refused to start: configuration is invalid.",
    "",
    ...diagnostics.map((entry) => {
      const shown =
        entry.presented === "absent"
          ? "(not set)"
          : entry.redacted
            ? "[redacted]"
            : `"${entry.shownValue ?? ""}"`;
      return `  ${entry.field} ${entry.problem} — received ${shown}`;
    }),
    "",
    `${diagnostics.length} configuration problem(s). Nothing was started; no port was bound.`,
  ];
  return `${lines.join("\n")}\n`;
}
