// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the running
// `ToolRegistryService`, `ToolExecutorService` and `McpToolAclService` already
// have. They are a POLICY VALUE passed into a use case, not a module constant
// read from an ambient environment, because a limit read from a process
// variable inside a domain rule is untestable and is exactly the coupling ADR
// M0.3 §2 bans.
//
// The one value the source DOES read from the environment —
// `env.MCP_CALL_TIMEOUT_MS ?? 30_000` on the MCP leg — keeps its default here
// and moves the override to the composition root, where an installation
// already supplies the rest of this bundle.

export interface ToolDiscoveryPolicy {
  /**
   * How many tools one `find_tools` answer may carry.
   *
   * Fifteen, transcribed. It is a MODEL-CONTEXT budget rather than a paging
   * limit: the result set is spliced into a prompt, and a larger answer buys
   * recall at the cost of the room the model needs to reason about it.
   */
  readonly defaultSearchLimit: number;
  /** Widest search a caller may ask for, whatever it requests. */
  readonly maximumSearchLimit: number;
  /**
   * The BM25 term-saturation parameter, `k1`.
   *
   * At 1.5 a term's third occurrence still moves the score and its thirtieth
   * barely does — the standard value, and the right one for tool descriptions,
   * where a repeated word is a hint and not a topic.
   */
  readonly termSaturation: number;
  /**
   * The BM25 length-normalisation parameter, `b`.
   *
   * At 0.75 a long description is discounted but not disqualified. Zero would
   * let a verbose tool outrank a precise one on every query; one would punish
   * the tools whose authors documented them properly.
   */
  readonly lengthNormalisation: number;
}

export interface ToolDispatchPolicy {
  /** Budget for one call to an entity backend over the wire transport. */
  readonly wireTimeoutMs: number;
  /** Budget for one call to an entity backend over MCP. */
  readonly mcpTimeoutMs: number;
  /**
   * What a backend's absent or unparseable `retry-after` becomes.
   *
   * The source returns the header when it is all digits and 60 otherwise. A
   * missing hint is not a licence to retry immediately, and the model reading
   * the failure is the thing that decides whether to wait.
   */
  readonly defaultRetryAfterSeconds: number;
}

export interface ToolAclPolicy {
  /** Widest page the tool-policy surface may return. Transcribed. */
  readonly maximumPageSize: number;
  /**
   * The scope label a policy carries when nobody chose one.
   *
   * `mcp:tools`, transcribed. It is a LABEL and not a permission: the identity
   * filter requires the caller to hold every label on the policy, so the
   * default is the weakest non-empty requirement rather than no requirement.
   */
  readonly defaultScopeLabel: string;
  /** The identity mode a policy demands when nobody chose one. */
  readonly defaultMinimumIdentityMode: "anonymous" | "bearer" | "oidc";
}

export interface ToolsPolicy {
  readonly discovery: ToolDiscoveryPolicy;
  readonly dispatch: ToolDispatchPolicy;
  readonly acl: ToolAclPolicy;
}

export const DEFAULT_TOOLS_POLICY: ToolsPolicy = Object.freeze({
  discovery: Object.freeze({
    defaultSearchLimit: 15,
    maximumSearchLimit: 200,
    termSaturation: 1.5,
    lengthNormalisation: 0.75,
  }),
  dispatch: Object.freeze({
    wireTimeoutMs: 30_000,
    mcpTimeoutMs: 30_000,
    defaultRetryAfterSeconds: 60,
  }),
  acl: Object.freeze({
    maximumPageSize: 200,
    defaultScopeLabel: "mcp:tools",
    defaultMinimumIdentityMode: "bearer",
  }),
});
