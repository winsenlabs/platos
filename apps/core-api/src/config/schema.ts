// The startup configuration surface of the core-api process.
//
// SCOPE. WIN-260 owns the typed-configuration CONTRACT for the platform. This
// module is the narrow thing WIN-297 owes it: the process-lifecycle hook that
// contract validates in. It declares only what a process needs to BE a process —
// where to listen, how long to drain, how to correlate, how loudly to log. No
// context configuration, no store credentials, no provider keys.
//
// AND THAT SCOPE SENTENCE IS STILL TRUE AFTER WIN-260 (M2.5). The five sibling
// sections this milestone adds — stores, providers, channels, durable runtime
// and security — are SEPARATE modules beside this one, each with its own field
// table and its own typed result, composed by `platform.ts`. The store
// credentials and provider settings did not move in here; the reason they are
// named in the paragraph above is that they belong somewhere ELSE, and now they
// have somewhere else to be.
//
// WHAT THIS FILE GAINED. The `ConfigFieldSpec` shape below is the one field
// vocabulary all six sections share, so it grew two kinds and three optional
// constraints for theirs. One engine, in `load.ts`, validates every field of
// every section: a second validator that happened to agree with this one would
// be the weaker census this repository keeps refusing to ship.
//
// EVERY FIELD CARRIES ITS OWN REDACTION CLASSIFICATION. Redaction is a property
// of the schema, not of the diagnostic writer's discipline: a field marked
// `secret` can never have its value rendered, because the renderer reads this
// flag rather than remembering a rule. `load.ts` proves both halves — a
// non-secret value IS echoed, a secret value is NOT — because a redactor that
// prints nothing at all is indistinguishable from one that works.

/**
 * How a field's value is parsed, and therefore how it can fail.
 *
 * WIN-260 adds `boolean` and `url` to WIN-297's three. Both were previously
 * spelled as `string` plus a comment, which is a validation rule that runs
 * nowhere: `PLATOS_STORE_REDIS_TLS=yes` and a bucket endpoint of `localhost`
 * would both have been accepted and would both have failed at first use, which
 * is the exact behaviour this milestone exists to remove.
 */
export type ConfigFieldKind = "string" | "integer" | "enum" | "boolean" | "url";

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
  /**
   * `string` only: a regular expression the trimmed value must match WHOLE.
   *
   * Held as source text rather than as a `RegExp` so a field spec stays a frozen
   * plain value that can be compared, serialised and printed. The engine anchors
   * it; a spec that anchored itself could silently accept a prefix match.
   */
  readonly pattern?: string;
  /** `pattern` only: what the pattern means, in operator language. Required with it. */
  readonly patternDescribe?: string;
  /** `url` only: the accepted schemes, colon included (`"postgresql:"`). */
  readonly schemes?: readonly string[];
}

/**
 * A GROUP: one anchor field plus the fields that only mean anything beside it.
 *
 * WHY GROUPS EXIST, AND WHY THEY ARE NOT JUST "REQUIRED". The core section can
 * demand `PLATOS_ENVIRONMENT` unconditionally because a process without one is
 * not a process. Nothing in the five sibling sections is like that: an install
 * with no object store is a legitimate install, and a V1 process must still boot
 * for it — readiness reports the unsatisfied bindings, which is the honest
 * answer. So a store is DECLARED or ABSENT, and the group is the unit of that
 * decision.
 *
 * The half-configured case is the one this shape exists to catch. Setting
 * `PLATOS_STORE_OBJECT_BUCKET` and forgetting the endpoint reads, to every
 * "required-or-default" scheme, as a bucket name nobody asked for: it validates,
 * it boots, the adapter is never constructed, and the operator's belief that the
 * store is wired survives until the first upload. An anchor makes both halves
 * loud — a member without its anchor is orphaned, an anchor without its required
 * members is incomplete — and both fail startup with the variable named.
 */
export interface ConfigGroupSpec {
  /** Stable identifier. Appears in the typed result and in every diagnostic. */
  readonly id: string;
  /** Operator-facing name of what this group configures. */
  readonly describe: string;
  /**
   * The field whose PRESENCE declares the group. It is never `required` in its
   * own right — absence is a legitimate answer, and means "not wired here".
   */
  readonly anchor: ConfigFieldSpec;
  /** Fields that must be present and valid once the anchor is. */
  readonly requiredWithAnchor: readonly ConfigFieldSpec[];
  /** Fields that take their default once the anchor is present. */
  readonly optional: readonly ConfigFieldSpec[];
}

/** One typed configuration module: a name and the groups it owns. */
export interface ConfigSectionSpec {
  readonly id: string;
  readonly describe: string;
  readonly groups: readonly ConfigGroupSpec[];
}

/** Every field a group can carry, anchor first. Order is the diagnostic order. */
export function groupFields(group: ConfigGroupSpec): readonly ConfigFieldSpec[] {
  return [group.anchor, ...group.requiredWithAnchor, ...group.optional];
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
