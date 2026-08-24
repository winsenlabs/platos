import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  PRISMA_TOKEN,
  type ControlDatabaseClient,
} from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

/**
 * Theme K.3 — 4-tier MCP permission gateway.
 *
 * Effective policy = MOST_RESTRICTIVE(platform, org, agent, user-session).
 * Each tier can only TIGHTEN the state, never loosen. Tier 1 `block`
 * wins over tier 4 `auto_allow`. Tier 3 `require_approval` upgrades
 * tier 2 `auto_allow`.
 *
 * States:
 *   auto_allow       → handler runs, audit written, result streamed.
 *   require_approval → fire `PlatosAgentApproval`, block turn on waitpoint.
 *   block            → immediate error, no approval, no retry.
 */

export type McpPermissionState = "auto_allow" | "require_approval" | "block";

/**
 * Hardcoded tier-1 rules. These are MINIMUMS — they cannot be
 * downgraded by tiers 2/3/4. They can be tightened further.
 *
 * Reasoning for each entry:
 *   - `gdpr.*` — GDPR actions are irreversible + audit-critical.
 *   - `trigger.envvars.delete` — deletes a secret the env needs.
 *   - `entities.register` — adds a new tool backend to the scope.
 *   - `filesystem.delete_file` / `filesystem.write_file` — local MCP
 *     filesystem tools; destructive to operator host.
 *   - `agents.delete`, `agents.rollback`, `agents.canary.promote` —
 *     state-changing admin ops, cross-user impact.
 *
 * Glob patterns: `*` matches any segment(s) after a namespace prefix.
 */
const PLATFORM_TIER_MINIMUMS: Array<{ pattern: string; min: McpPermissionState }> = [
  { pattern: "gdpr.*", min: "require_approval" },
  { pattern: "trigger.envvars.delete", min: "require_approval" },
  { pattern: "trigger.envvars.upsert", min: "require_approval" },
  // K.6 — deployment promotion is cross-user and irreversible (replaces
  // the current-deployment pointer on a live environment).
  { pattern: "trigger.deployments.promote", min: "require_approval" },
  { pattern: "entities.register", min: "require_approval" },
  // K.5 — entities.delete removes a tool backend from the scope
  // (cascades tool-sync registrations). Always gated.
  { pattern: "entities.delete", min: "require_approval" },
  { pattern: "entities.regenerate_secret", min: "require_approval" },
  // MCPF-W1 — entity MCP gateway management.
  //   - set_mcp_enabled flips the flag that makes the customer-facing
  //     `/mcp/entity/:id` reachable; cross-tenant impact.
  //   - generate_mcp_token mints a bearer PAT for MCP access (shown once).
  //   - set_test_credentials writes encrypted headers used for outbound
  //     test calls; treat as a credentials write.
  { pattern: "entities.set_mcp_enabled", min: "require_approval" },
  // MCPF-followup — flipping this on causes Platos to merge a `_context`
  // envelope into every MCP-origin tool call's arguments. Entity backends
  // that don't pop the kwarg crash. Cross-customer impact — gate it.
  { pattern: "entities.set_mcp_inject_context", min: "require_approval" },
  { pattern: "entities.generate_mcp_token", min: "require_approval" },
  { pattern: "entities.set_test_credentials", min: "require_approval" },
  { pattern: "filesystem.delete_file", min: "require_approval" },
  { pattern: "filesystem.write_file", min: "require_approval" },
  { pattern: "agents.delete", min: "require_approval" },
  { pattern: "agents.rollback", min: "require_approval" },
  { pattern: "agents.canary.promote", min: "require_approval" },
  { pattern: "agents.visibility.set", min: "require_approval" },
  { pattern: "memories.import_replace", min: "require_approval" },
  // MCPF-W2 — hard-delete up to 100 memories in one round-trip. Irreversible
  // (use `memories.archive` for the reversible path); always gated.
  // `memories.archive` / `memories.restore` are reversible and stay auto-allow.
  // `threads.edit_and_rerun` soft-deletes downstream messages but preserves
  // the parent + creates a new revision, so it's not strictly destructive.
  { pattern: "memories.bulk_delete", min: "require_approval" },
  { pattern: "messages.edit_and_rerun", min: "require_approval" },
  // K.7 — installs untrusted skill manifests + prompt blocks scoped to
  // the project. Community-origin by default, so treat as destructive.
  { pattern: "skills.install", min: "require_approval" },
  // K.14 — orchestration composites. Each fans out 3-5 destructive writes
  // server-side, so the gate sits at the composite rather than individual
  // wrapped services.
  //   - deploy_with_skills    creates an agent + installs skills (untrusted prompt-block code).
  //   - provision             creates a new entity + tool-mapping stubs.
  //   - bootstrap_demo_data   seeds demo rows; fine for dev, risky in prod.
  { pattern: "agents.deploy_with_skills", min: "require_approval" },
  { pattern: "entities.provision", min: "require_approval" },
  { pattern: "scopes.bootstrap_demo_data", min: "require_approval" },
  // K.17 — operator-level mutations on saved macros. Publishing a macro
  // makes it visible to every operator in the same scope; deletion is
  // irreversible; update can rewrite the stored step sequence. Replay
  // is auto-allow (each step still hits its own tier-1 gate).
  // TODO(K.17.1) — require first-run approval after create for `macros.replay`.
  { pattern: "macros.update", min: "require_approval" },
  { pattern: "macros.delete", min: "require_approval" },
  { pattern: "macros.share", min: "require_approval" },
  // K.15 — notification rules exfiltrate scoped event data to external
  // systems (Slack / PagerDuty / arbitrary webhooks). Each rule
  // mutation is operator-level admin. events.subscribe / recent +
  // notifications.list / get / test stay auto-allow (read-only or
  // self-scoped synthetic tests).
  { pattern: "notifications.register", min: "require_approval" },
  { pattern: "notifications.update", min: "require_approval" },
  { pattern: "notifications.delete", min: "require_approval" },
  // K.18 — admin-tier cross-scope tools. Every call that touches data
  // outside a single pinned scope sits behind `require_approval` at the
  // platform tier so an admin token never silently drains the org. The
  // tools themselves are only mounted on the router when the caller has
  // a tier="admin" token (router-level gate in handler.execute).
  //   - scopes.list_all              — walks every (org, project, env).
  //   - tool_calls.cross_scope_audit — reads ToolCalls across scopes.
  //   - budgets.rollup_org_wide      — aggregates spend across scopes.
  //   - agents.census                — counts agents across scopes.
  //   - entities.census              — counts entities across scopes.
  //   - gdpr.export_user_everywhere  — cross-scope GDPR export (destructive).
  { pattern: "scopes.list_all", min: "require_approval" },
  { pattern: "tool_calls.cross_scope_audit", min: "require_approval" },
  { pattern: "budgets.rollup_org_wide", min: "require_approval" },
  { pattern: "agents.census", min: "require_approval" },
  { pattern: "entities.census", min: "require_approval" },
  { pattern: "gdpr.export_user_everywhere", min: "require_approval" },
  // MCPF-W3 — provider integration mutations.
  //   - add_key      links a ProviderKey to a same-Environment Credential;
  //                  not directly destructive but unlocks model spend on a
  //                  new key, so always gated.
  //   - delete_key   removes the pointer row (refused if agents pinned).
  //   - rotate_key   atomically relinks to another provider-matched Credential.
  //   - set_routes   writes per-agent modelRoutes JSON; alters which
  //                  provider key the runtime hits at request time.
  // get / list / test_credentials / get_routes are read-only — auto-allow.
  { pattern: "providers.add_key", min: "require_approval" },
  { pattern: "providers.delete_key", min: "require_approval" },
  { pattern: "providers.rotate_key", min: "require_approval" },
  { pattern: "providers.set_routes", min: "require_approval" },
  // MCPF-W3 — OAuth client lifecycle. `create_client` mints a credential
  // pair (returned ONCE); `delete_client` cascade-revokes every live
  // token; `rotate_secret` invalidates the previous secret. All three
  // are credential-grade mutations.
  // list_clients / list_tokens / revoke_token (single-token) stay
  // auto-allow — list is read, revoke_token is intentionally cheap so
  // operators can stop a leaking PAT without paperwork (RFC 7009 §2.2
  // also requires unknown-token revocation to succeed silently).
  { pattern: "oauth.create_client", min: "require_approval" },
  { pattern: "oauth.delete_client", min: "require_approval" },
  { pattern: "oauth.rotate_secret", min: "require_approval" },
  // MCPF-W4 — Job mutations execute operator-authored JS in a
  // sandboxed trigger.dev context. Every write surface is gated:
  //   - create / update              register or replace executable code
  //   - delete                       irreversible row removal
  //   - run                          manual dispatch (executes code, may have side effects)
  //   - set_enabled                  flips the dispatch gate
  // Read tools (list, get, get_runs, get_run, validate_handler) stay
  // auto-allow — they're inert.
  { pattern: "jobs.create", min: "require_approval" },
  { pattern: "jobs.update", min: "require_approval" },
  { pattern: "jobs.delete", min: "require_approval" },
  { pattern: "jobs.dispatch", min: "require_approval" },
  { pattern: "jobs.set_enabled", min: "require_approval" },
  // MCPF-W4 — alert channel mutations register / mutate / remove
  // outbound notification destinations. Each create / update / delete
  // changes who receives PAGER-style notifications across env types in
  // the project, so they're operator-grade admin. Read paths (list,
  // test, get_integration) stay auto-allow.
  { pattern: "alert_channels.create", min: "require_approval" },
  { pattern: "alert_channels.update", min: "require_approval" },
  { pattern: "alert_channels.delete", min: "require_approval" },
  // Connect/channel doorway mutations (PlatosChannelConnection).
  //   - create                 binds a messaging-channel doorway to an agent,
  //                            stores encrypted provider credentials, and
  //                            returns the full inbound webhook path + secret.
  //   - update                 can rebind agentId / overwrite credentials /
  //                            flip enabled on a live inbound integration.
  //   - delete                 removes the connection, cascading every
  //                            PlatosChannelThread mapping.
  //   - rotate_webhook_secret  invalidates the live inbound webhook URL and
  //                            reveals a fresh plaintext secret + webhook path.
  // channels.list / channels.get stay auto-allow (read-only, secrets redacted).
  { pattern: "channels.create", min: "require_approval" },
  { pattern: "channels.update", min: "require_approval" },
  { pattern: "channels.delete", min: "require_approval" },
  { pattern: "channels.rotate_webhook_secret", min: "require_approval" },
  // Connect v3 (Phase D) — BYO manifest MINT on the connection tier. Strictly
  // MORE powerful than channels.create: it creates a PlatosChannelConnection
  // row, POSTs the pasted config token to Slack's apps.manifest.create, and
  // stores the returned client_secret / signing_secret encrypted on the row.
  // The REST path is operator-gated; without this entry the MCP path would
  // resolve to auto_allow for a scope-tier token. Gate it like its siblings.
  { pattern: "channels.mint_from_manifest", min: "require_approval" },
  // Connect v3 — marketplace channel-APP mutations (PlatosChannelApp +
  // PlatosChannelInstallation). An app is OAuth-installed into N external
  // workspaces, so every write has cross-tenant blast radius:
  //   - create             mints a publishable Slack app identity + stores its
  //                        encrypted clientSecret / signingSecret.
  //   - update             can rotate the app's OAuth/signing credentials or
  //                        rebind the default agent for every installation.
  //   - delete             cascades every PlatosChannelInstallation + thread
  //                        (uninstalls the app from all workspaces at once).
  //   - bind_installation  rebinds ONE external workspace to a different agent /
  //                        routing table.
  //   - import_installation registers an external workspace install from an
  //                        operator-supplied bot token (stores an encrypted
  //                        credential + can bind an agent) WITHOUT OAuth.
  //   - revoke_installation soft-revokes ONE external workspace (cuts its bot).
  // channel_apps.list / get / list_installations / installations_status stay
  // auto-allow (read-only, secrets redacted).
  { pattern: "channel_apps.create", min: "require_approval" },
  { pattern: "channel_apps.update", min: "require_approval" },
  { pattern: "channel_apps.delete", min: "require_approval" },
  { pattern: "channel_apps.bind_installation", min: "require_approval" },
  { pattern: "channel_apps.import_installation", min: "require_approval" },
  { pattern: "channel_apps.revoke_installation", min: "require_approval" },
  // MCPF-W5 — knowledge graph mutations.
  //   - delete_node     irreversibly cascade-deletes the entity AND every
  //                     relationship pointing to or from it.
  //   - discover_links  walks an O(n²) candidate set across the user's
  //                     entities + can auto-materialise edges when
  //                     `autoLink: true`. Approval-gated as a defence
  //                     against runaway scans + unintended bulk writes.
  // Other kg.* mutations (create_node / update_node / link_nodes) stay
  // auto-allow — they're scoped, audited, and individually scoped to a
  // single row each.
  { pattern: "kg.delete_node", min: "require_approval" },
  { pattern: "kg.discover_links", min: "require_approval" },
  // MCPF-W5 — skill library management.
  //   - update             rewrites name/description/tags on the registry
  //                        row; visible to every agent in scope.
  //   - disable_globally   flips `enabled=false` across every PlatosAgentSkill
  //                        in scope; affects live agent runtime behaviour.
  //   - uninstall          permanently removes the skill row; pre-checked
  //                        for usage but still irreversible.
  // `skills.get_installed_config` is read-only — auto-allow.
  { pattern: "skills.update", min: "require_approval" },
  { pattern: "skills.disable_globally", min: "require_approval" },
  { pattern: "skills.uninstall", min: "require_approval" },
  // MCPF-W6 — settings / admin mutations.
  //   - org.update                 mutates org `title` (visible to every member).
  //   - org.add_member             mints an OrgMemberInvite (cross-tenant invite).
  //   - org.remove_member          removes an OrgMember row (last-admin-protected).
  //   - org.set_member_role        flips ADMIN ↔ MEMBER (last-admin-protected).
  // org.list / org.get / org.list_members + projects.list_all are read-only.
  { pattern: "org.update", min: "require_approval" },
  { pattern: "org.add_member", min: "require_approval" },
  { pattern: "org.remove_member", min: "require_approval" },
  { pattern: "org.set_member_role", min: "require_approval" },
  // MCPF-W6 — environment + secret mutations.
  //   - environments.create        mints a new RuntimeEnvironment in the project.
  //   - environments.delete        soft-archives an env (refused when agents
  //                                 reference it; PRODUCTION envs are protected).
  //   - environments.set_secret    writes/updates a SecretStore row (operator-
  //                                 grade — secrets are decrypted into the
  //                                 agent runtime by the ScopedEnvService).
  //   - environments.delete_secret removes a SecretStore row.
  // environments.list + list_secrets are read-only.
  { pattern: "environments.create", min: "require_approval" },
  { pattern: "environments.delete", min: "require_approval" },
  { pattern: "environments.set_secret", min: "require_approval" },
  { pattern: "environments.delete_secret", min: "require_approval" },
  // MCPF-W6 — cluster mutations.
  //   - clusters.create   mints a new PlatosAgentCluster row.
  //   - clusters.add_agent  attaches an agent to a cluster (alters cross-
  //                          agent memory + thread visibility per PRA-AC).
  // clusters.list is read-only.
  { pattern: "clusters.create", min: "require_approval" },
  { pattern: "clusters.add_agent", min: "require_approval" },
];

function stateOrder(s: McpPermissionState): number {
  return s === "block" ? 2 : s === "require_approval" ? 1 : 0;
}

/**
 * MCPF-followup — heuristic to decide whether a tool name is mutating.
 *
 * Used by the admin-tier auto-escalation rule so reads from an admin
 * token don't pile up approval rows. The list is intentionally
 * pattern-based (suffix match) rather than a per-tool allowlist so new
 * read-only tools don't have to be added to a registry.
 *
 * Conservative bias: anything we're not sure about is treated as
 * mutating (returns true). The tier-1 minimum table above already
 * declares everything we KNOW is destructive; the heuristic only adds
 * coverage for any unmapped mutators.
 */
const READ_ONLY_PATTERNS: ReadonlyArray<RegExp> = [
  /\.list$/,
  /\.list_[a-z_]+$/,           // list_keys, list_members, list_secrets, …
  /\.get$/,
  /\.get_[a-z_]+$/,             // get_tools, get_routes, get_test_credentials, …
  /\.search$/,
  /\.census$/,
  /\.whoami$/,
  /\.list_accessible_scopes$/,
  /\.test_credentials$/,        // health probe — does not mutate persistent state
  /\.test$/,                    // alert_channels.test, mcp.test, …
  /\.validate_handler$/,        // jobs.validate_handler — pure compile check
  /^monitoring\./,              // every monitoring.* is read-only
  /^events\.recent$/,
  /^events\.subscribe$/,        // open a stream; doesn't write
  /^audit\./,                   // remaining audit ledgers are read-only
  /^tool_calls\./,              // ToolCall queries are read-only
  /^reflection\./,              // explain_turn / simulate_turn / diff_agents — read
  /^macros\.list$/,
  /^macros\.replay_log$/,
];

export function isMutatingToolName(toolName: string): boolean {
  for (const re of READ_ONLY_PATTERNS) {
    if (re.test(toolName)) return false;
  }
  return true;
}

function mostRestrictive(
  ...states: Array<McpPermissionState | null | undefined>
): McpPermissionState {
  let winner: McpPermissionState = "auto_allow";
  for (const s of states) {
    if (!s) continue;
    if (stateOrder(s) > stateOrder(winner)) winner = s;
  }
  return winner;
}

function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return toolName.startsWith(`${prefix}.`) || toolName === prefix;
  }
  return false;
}

function normalizePolicy(raw: unknown): McpPermissionState | null {
  if (raw === "auto_allow" || raw === "require_approval" || raw === "block") {
    return raw;
  }
  return null;
}

function fromPolicyEffect(effect: "ALLOW" | "DENY"): McpPermissionState {
  return effect === "DENY" ? "block" : "auto_allow";
}

function toPolicyEffect(policy: McpPermissionState): "ALLOW" | "DENY" {
  if (policy === "block") return "DENY";
  if (policy === "auto_allow") return "ALLOW";
  throw new Error("organization MCP policies support only auto_allow or block");
}

export interface ResolvePermissionInput {
  scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;
  agentId: string | null;
  userId: string | null;
  toolName: string;
  sessionOverrides?: Record<string, McpPermissionState>;
  /**
   * K.18 — the verified MCP token's tier. When "admin", any non-block
   * effective state is upgraded to `require_approval` so the operator
   * is always in the loop for cross-scope operations.
   */
  tokenTier?: "scope" | "admin";
}

export interface ResolvedPermission {
  state: McpPermissionState;
  /** Which tier won — useful for audit logs + error messages. */
  tier: 1 | 2 | 3 | 4;
  reason: string;
}

@Injectable()
export class MCPPermissionGatewayService {
  private readonly logger = new Logger(MCPPermissionGatewayService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  /** Tier-1 platform baseline. Matches pattern list to get the minimum. */
  private readPlatformMinimum(toolName: string): McpPermissionState {
    for (const rule of PLATFORM_TIER_MINIMUMS) {
      if (matchesPattern(rule.pattern, toolName)) return rule.min;
    }
    return "auto_allow";
  }

  /** Tier-2 org policy — DB lookup. Returns null when no matching row. */
  private async readOrgPolicy(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    toolName: string,
  ): Promise<McpPermissionState | null> {
    const rows = await this.prisma.organizationMcpPolicy.findMany({
      where: { organizationId: scope.organizationId },
      select: { pattern: true, effect: true },
    });
    let winner: McpPermissionState | null = null;
    for (const row of rows) {
      if (matchesPattern(row.pattern, toolName)) {
        const normalized = fromPolicyEffect(row.effect);
        if (normalized && (!winner || stateOrder(normalized) > stateOrder(winner))) {
          winner = normalized;
        }
      }
    }
    return winner;
  }

  /** Tier-3 per-agent override from the active version's typed tool policy. */
  private async readAgentOverride(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    agentId: string,
    toolName: string,
  ): Promise<McpPermissionState | null> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        agent: { projectId: scope.projectId },
      },
      select: {
        activeAgentVersion: {
          select: {
            toolDefaultPolicy: true,
            toolPolicies: {
              where: { tool: { name: toolName } },
              orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { effect: true },
            },
          },
        },
      },
    });
    if (!binding) {
      this.logger.warn("MCP permission denied: scoped AgentBinding was not found");
      return "block";
    }
    const explicit = binding.activeAgentVersion.toolPolicies[0];
    if (explicit) return fromPolicyEffect(explicit.effect);
    return binding.activeAgentVersion.toolDefaultPolicy === "ALL" ? "auto_allow" : "block";
  }

  /** Tier-4 session override — passed in by the caller; no DB touch. */
  private readSessionOverride(
    sessionOverrides: Record<string, McpPermissionState> | undefined,
    toolName: string,
  ): McpPermissionState | null {
    if (!sessionOverrides) return null;
    if (toolName in sessionOverrides) return sessionOverrides[toolName] ?? null;
    for (const [pattern, policy] of Object.entries(sessionOverrides)) {
      if (matchesPattern(pattern, toolName)) return policy;
    }
    return null;
  }

  async resolve(input: ResolvePermissionInput): Promise<ResolvedPermission> {
    const t1 = this.readPlatformMinimum(input.toolName);
    if (t1 === "block") return { state: "block", tier: 1, reason: "platform-tier block" };

    const t2 = await this.readOrgPolicy(input.scope, input.toolName);
    if (t2 === "block") return { state: "block", tier: 2, reason: "org-policy block" };

    const t3 = input.agentId
      ? await this.readAgentOverride(input.scope, input.agentId, input.toolName)
      : null;
    if (t3 === "block") return { state: "block", tier: 3, reason: "agent-policy block" };

    const t4 = this.readSessionOverride(input.sessionOverrides, input.toolName);
    if (t4 === "block") return { state: "block", tier: 4, reason: "session-override block" };

    let state = mostRestrictive(t1, t2, t3, t4);
    // Pick the tier that "won" for audit clarity.
    const tiers: Array<{ t: 1 | 2 | 3 | 4; s: McpPermissionState | null }> = [
      { t: 1, s: t1 },
      { t: 2, s: t2 },
      { t: 3, s: t3 },
      { t: 4, s: t4 },
    ];
    let winnerTier: 1 | 2 | 3 | 4 = 1;
    for (const { t, s } of tiers) {
      if (s && stateOrder(s) === stateOrder(state)) {
        winnerTier = t;
      }
    }

    // K.18 — admin-tier auto-escalation (REVISED for MCPF-followup).
    //
    // The original rule promoted EVERY non-block call from an admin token to
    // `require_approval`. That made admin tokens functionally unusable: read-
    // only ops like `platos.whoami` / `agents.list` / `entities.get` queued
    // up an approval per call. The intent of K.18 was "admin tokens get
    // extra friction on SENSITIVE ops," not on every dispatch.
    //
    // New rule: admin-tier escalation only fires when the resolved tool is
    // already mutating/destructive — defined as either:
    //   (a) the tool already had `require_approval` minimum from tier 1
    //       (the platform baseline list above), OR
    //   (b) the tool is heuristically mutating: NOT a read pattern such as
    //       `*.list`, `*.get`, `*.search`, `*.census`, `*.cost.*`,
    //       `*.test_credentials`, etc.
    //
    // Tier-1 `block` still wins (handled at the top of this method).
    if (input.tokenTier === "admin" && state !== "block") {
      const isMutating = isMutatingToolName(input.toolName) || t1 === "require_approval";
      if (isMutating && state !== "require_approval") {
        state = "require_approval";
        return {
          state,
          tier: winnerTier,
          reason: `tier-${winnerTier} ${state} (admin-token auto-escalate, mutating)`,
        };
      }
    }

    return {
      state,
      tier: winnerTier,
      reason: `tier-${winnerTier} ${state}`,
    };
  }

  // ── CRUD helpers for tier-2 policy ─────────────────────────────────
  async listOrgPolicies(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ) {
    const rows = await this.prisma.organizationMcpPolicy.findMany({
      where: { organizationId: scope.organizationId },
      orderBy: [{ pattern: "asc" }],
    });
    return rows.map(({ effect, ...row }) => ({ ...row, policy: fromPolicyEffect(effect) }));
  }

  async upsertOrgPolicy(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    pattern: string,
    policy: McpPermissionState,
  ) {
    if (!pattern || pattern.length < 1 || pattern.length > 200) {
      throw new Error("pattern must be 1–200 chars");
    }
    const effect = toPolicyEffect(policy);
    // Upsert via find + update/create since the unique key is composite.
    const existing = await this.prisma.organizationMcpPolicy.findFirst({
      where: { organizationId: scope.organizationId, pattern },
      select: { id: true },
    });
    if (existing) {
      const updated = await this.prisma.organizationMcpPolicy.update({
        where: { id: existing.id },
        data: { effect },
      });
      const { effect: savedEffect, ...row } = updated;
      return { ...row, policy: fromPolicyEffect(savedEffect) };
    }
    const created = await this.prisma.organizationMcpPolicy.create({
      data: {
        organizationId: scope.organizationId,
        pattern,
        effect,
      },
    });
    const { effect: savedEffect, ...row } = created;
    return { ...row, policy: fromPolicyEffect(savedEffect) };
  }

  async deleteOrgPolicy(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
    id: string,
  ) {
    const existing = await this.prisma.organizationMcpPolicy.findFirst({
      where: { id, organizationId: scope.organizationId },
      select: { id: true },
    });
    if (!existing) return false;
    await this.prisma.organizationMcpPolicy.delete({ where: { id } });
    return true;
  }

  /** Export for tests and tools that want to know the baseline. */
  static platformMinimums(): ReadonlyArray<{ pattern: string; min: McpPermissionState }> {
    return PLATFORM_TIER_MINIMUMS;
  }
}
