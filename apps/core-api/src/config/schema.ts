// The startup configuration surface of the core-api process.
//
// SCOPE. WIN-260 owns the typed-configuration CONTRACT for the platform. This
// module is the narrow thing WIN-297 owes it: the process-lifecycle hook that
// contract validates in. It declares only what a process needs to BE a process —
// where to listen, how long to drain, how to correlate, how loudly to log. No
// context configuration, no store credentials, no provider keys.
//
// EVERY FIELD CARRIES ITS OWN REDACTION CLASSIFICATION. Redaction is a property
// of the schema, not of the diagnostic writer's discipline: a field marked
// `secret` can never have its value rendered, because the renderer reads this
// flag rather than remembering a rule. `load.ts` proves both halves — a
// non-secret value IS echoed, a secret value is NOT — because a redactor that
// prints nothing at all is indistinguishable from one that works.

/** How a field's value is parsed, and therefore how it can fail. */
export type ConfigFieldKind = "string" | "integer" | "enum";

export interface ConfigFieldSpec {
  /** The environment variable. Fields are addressed by this name everywhere. */
  readonly name: string;
  readonly kind: ConfigFieldKind;
  /** A field with no default and no value fails startup. */
  readonly required: boolean;
  readonly defaultValue: string | null;
  /**
   * True when the value must never be rendered into a diagnostic, a log line or
   * an HTTP response. The renderer reads this; it does not maintain its own list.
   */
  readonly secret: boolean;
  /** Operator-facing description. Rendered on failure; never contains a value. */
  readonly describe: string;
  /** `enum` only: the closed set of accepted values. */
  readonly allowed?: readonly string[];
  /** `integer` only: inclusive bounds. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** `string` only: minimum accepted length, after trimming. */
  readonly minimumLength?: number;
}

export const CORE_API_CONFIG_FIELDS: readonly ConfigFieldSpec[] = Object.freeze([
  Object.freeze({
    name: "PLATOS_ENVIRONMENT",
    kind: "enum",
    required: true,
    defaultValue: null,
    secret: false,
    describe: "which environment this process believes it is running in",
    allowed: Object.freeze(["development", "test", "staging", "production"]),
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_HOST",
    kind: "string",
    required: false,
    defaultValue: "127.0.0.1",
    secret: false,
    describe: "the interface the HTTP listener binds",
    minimumLength: 1,
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_PORT",
    kind: "integer",
    required: false,
    defaultValue: "3030",
    secret: false,
    // 0 is meaningful and deliberate: it asks the kernel for a free port, which
    // is how the executable start/stop evidence runs several processes at once
    // without a port-allocation race deciding whether CI is green.
    describe: "the TCP port to listen on; 0 asks the operating system for a free one",
    minimum: 0,
    maximum: 65535,
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS",
    kind: "integer",
    required: false,
    defaultValue: "10000",
    secret: false,
    describe: "how long graceful shutdown waits for in-flight work before giving up",
    minimum: 1,
    maximum: 600000,
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_DRAIN_GRACE_MS",
    kind: "integer",
    required: false,
    // Zero by default, and the default is a real decision rather than a
    // placeholder. An orchestrator that removes an instance from its endpoint
    // list before or alongside SIGTERM needs no grace period, and a non-zero
    // default would add that delay to every rolling deploy for nothing.
    //
    // Behind a load balancer that polls /readyz, set this to at least one poll
    // interval. Without it the readiness flip to `draining` is real but
    // unobservable: the listener stops accepting in the same tick, so a caller
    // that had not already connected gets a refused connection rather than the
    // 503 that would have told it to go elsewhere.
    defaultValue: "0",
    secret: false,
    describe: "how long to keep serving, readiness-red, before the listener stops accepting",
    minimum: 0,
    maximum: 300000,
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_REQUEST_ID_HEADER",
    kind: "string",
    required: false,
    defaultValue: "x-request-id",
    secret: false,
    describe: "the inbound header carrying an upstream correlation identifier",
    minimumLength: 1,
  }),
  Object.freeze({
    name: "PLATOS_LOG_LEVEL",
    kind: "enum",
    required: false,
    defaultValue: "info",
    secret: false,
    describe: "the minimum level this process emits",
    allowed: Object.freeze(["debug", "info", "warn", "error"]),
  }),
  Object.freeze({
    name: "PLATOS_CORE_API_ADMIN_HEALTH_TOKEN",
    kind: "string",
    required: false,
    defaultValue: null,
    // THE SECRET FIELD. Readiness detail names every unsatisfied adapter binding,
    // which is an inventory of what this install has not wired yet. That is
    // reconnaissance, so the detailed body is gated on this bearer token and the
    // public body carries a status and nothing else.
    secret: true,
    describe: "bearer token gating the detailed readiness body; omit to keep detail off entirely",
    minimumLength: 16,
  }),
]);

export type PlatosEnvironment = "development" | "test" | "staging" | "production";
export type CoreApiLogLevel = "debug" | "info" | "warn" | "error";

/** The validated result. Every field is present and already the right type. */
export interface CoreApiConfiguration {
  readonly environment: PlatosEnvironment;
  readonly host: string;
  readonly port: number;
  readonly shutdownTimeoutMs: number;
  readonly drainGraceMs: number;
  readonly requestIdHeader: string;
  readonly logLevel: CoreApiLogLevel;
  /** Null when unset: readiness detail is then unavailable to everyone. */
  readonly adminHealthToken: string | null;
}

export function configFieldByName(name: string): ConfigFieldSpec | undefined {
  return CORE_API_CONFIG_FIELDS.find((field) => field.name === name);
}
