// Tier 1 — the platform baseline, as data.
//
// These are MINIMUMS. Tiers 2, 3 and 4 may tighten any of them and none of them
// may loosen one. The list is the installation's answer to "what must never
// happen without a human saying so", and it is separated from the algebra in
// `domain/permission.ts` for one reason: this file changes when the product
// grows a destructive tool, and that file changes when the safety argument
// changes. Reviewing them together would hide the second class of change inside
// the first.
//
// WHAT EARNS AN ENTRY. Every rule below is one of:
//
//   IRREVERSIBLE      the row cannot be restored (`kg.delete_node`,
//                     `memories.bulk_delete`, `oauth.delete_client`).
//   CROSS-TENANT      the blast radius leaves the caller's scope
//                     (`channel_apps.*`, `scopes.list_all`, every `*.census`).
//   CREDENTIAL-GRADE  it mints, rotates or reveals secret material
//                     (`entities.generate_mcp_token`, `providers.rotate_key`).
//   CODE-EXECUTING    it registers or runs operator-authored code
//                     (`jobs.create`, `skills.install`).
//
// The reversible neighbours of these tools are deliberately absent, and the
// pairs are the argument: `memories.archive` / `memories.restore` are
// auto-allow because they undo, while `memories.bulk_delete` is gated because
// it does not. `oauth.revoke_token` is auto-allow on purpose — revoking a
// single leaking token must be cheaper than the paperwork, and RFC 7009 §2.2
// requires unknown-token revocation to succeed silently in any case.
//
// This list is transcribed from `PLATFORM_TIER_MINIMUMS` and holds its order,
// which keeps the diff against the source readable. Order does not affect the
// answer: the table DOES overlap in one place, and every overlapping pair
// agrees on its minimum — see `platformMinimumFor` below and the case that pins
// it in `permission.test.ts`.
//
// THREE PATTERNS NAME AN EXTERNAL VENDOR AND CANNOT BE RENAMED. The
// durable-runtime integration publishes its own MCP tool namespace, so those
// three entries are the LITERAL names a caller sends. They carry reviewed
// vocabulary-boundary exceptions, for exactly the reason that manifest's rule
// carves out: the term names the external integration rather than a Platos
// concept. Renaming them here would make the gate consult a pattern nothing
// matches, which is the one change to this file that would silently ungate a
// tool rather than merely mis-describe one.

import { matchesPattern, type PermissionState } from "./permission.js";

export interface PlatformMinimum {
  readonly pattern: string;
  readonly minimum: PermissionState;
}

const APPROVAL: PermissionState = "require_approval";

export const PLATFORM_TIER_MINIMUMS: readonly PlatformMinimum[] = Object.freeze([
  // Erasure is irreversible and audit-critical, and the namespace form covers
  // the export/purge/import surface as one rule.
  { pattern: "gdpr.*", minimum: APPROVAL },

  // Durable-runtime environment variables ARE secrets to the workloads that
  // read them, and promotion repoints a live environment at different code
  // for every user at once.
  { pattern: "trigger.envvars.delete", minimum: APPROVAL },
  { pattern: "trigger.envvars.upsert", minimum: APPROVAL },
  { pattern: "trigger.deployments.promote", minimum: APPROVAL },

  // Entity lifecycle. Registering one adds a tool backend to the scope;
  // deleting one cascades every exposure it owns.
  { pattern: "entities.register", minimum: APPROVAL },
  { pattern: "entities.delete", minimum: APPROVAL },
  { pattern: "entities.regenerate_secret", minimum: APPROVAL },
  // Flipping the MCP surface on makes `/mcp/entity/:id` publicly reachable.
  { pattern: "entities.set_mcp_enabled", minimum: APPROVAL },
  // Injecting the context envelope changes the ARGUMENTS every MCP-origin call
  // carries. A backend that does not pop the extra key crashes on the next call.
  { pattern: "entities.set_mcp_inject_context", minimum: APPROVAL },
  { pattern: "entities.generate_mcp_token", minimum: APPROVAL },
  { pattern: "entities.set_test_credentials", minimum: APPROVAL },

  // Local filesystem tools reach the operator's own host, not the platform's.
  { pattern: "filesystem.delete_file", minimum: APPROVAL },
  { pattern: "filesystem.write_file", minimum: APPROVAL },

  // Agent lifecycle changes what every future turn runs.
  { pattern: "agents.delete", minimum: APPROVAL },
  { pattern: "agents.rollback", minimum: APPROVAL },
  { pattern: "agents.canary.promote", minimum: APPROVAL },
  { pattern: "agents.visibility.set", minimum: APPROVAL },

  // Memory. `archive` and `restore` undo; these do not.
  { pattern: "memories.import_replace", minimum: APPROVAL },
  { pattern: "memories.bulk_delete", minimum: APPROVAL },
  { pattern: "messages.edit_and_rerun", minimum: APPROVAL },

  // Installing a skill installs an untrusted manifest and its prompt blocks.
  { pattern: "skills.install", minimum: APPROVAL },

  // Composites. Each fans out three to five destructive writes server-side, so
  // the gate sits at the composite rather than on the services it wraps.
  { pattern: "agents.deploy_with_skills", minimum: APPROVAL },
  { pattern: "entities.provision", minimum: APPROVAL },
  { pattern: "scopes.bootstrap_demo_data", minimum: APPROVAL },

  // Saved macros. Sharing publishes to every operator in the scope; replay is
  // auto-allow because each replayed step meets this table on its own.
  { pattern: "macros.update", minimum: APPROVAL },
  { pattern: "macros.delete", minimum: APPROVAL },
  { pattern: "macros.share", minimum: APPROVAL },

  // Notification rules exfiltrate scoped event data to external systems.
  { pattern: "notifications.register", minimum: APPROVAL },
  { pattern: "notifications.update", minimum: APPROVAL },
  { pattern: "notifications.delete", minimum: APPROVAL },

  // Cross-scope reads. Each walks past the single pinned scope an ordinary
  // token is confined to, so an admin token cannot silently drain the org.
  { pattern: "scopes.list_all", minimum: APPROVAL },
  { pattern: "tool_calls.cross_scope_audit", minimum: APPROVAL },
  { pattern: "budgets.rollup_org_wide", minimum: APPROVAL },
  { pattern: "agents.census", minimum: APPROVAL },
  { pattern: "entities.census", minimum: APPROVAL },
  { pattern: "gdpr.export_user_everywhere", minimum: APPROVAL },

  // Provider integration. Adding a key is not destructive but it unlocks model
  // spend; routes decide which key the runtime hits at request time.
  { pattern: "providers.add_key", minimum: APPROVAL },
  { pattern: "providers.delete_key", minimum: APPROVAL },
  { pattern: "providers.rotate_key", minimum: APPROVAL },
  { pattern: "providers.set_routes", minimum: APPROVAL },

  // OAuth client lifecycle — all three are credential-grade.
  { pattern: "oauth.create_client", minimum: APPROVAL },
  { pattern: "oauth.delete_client", minimum: APPROVAL },
  { pattern: "oauth.rotate_secret", minimum: APPROVAL },

  // Jobs execute operator-authored code in a sandboxed durable context. Every
  // write surface is gated; `validate_handler` is a pure compile check.
  { pattern: "jobs.create", minimum: APPROVAL },
  { pattern: "jobs.update", minimum: APPROVAL },
  { pattern: "jobs.delete", minimum: APPROVAL },
  { pattern: "jobs.dispatch", minimum: APPROVAL },
  { pattern: "jobs.set_enabled", minimum: APPROVAL },

  // Alert channels decide who is paged, across every environment in a project.
  { pattern: "alert_channels.create", minimum: APPROVAL },
  { pattern: "alert_channels.update", minimum: APPROVAL },
  { pattern: "alert_channels.delete", minimum: APPROVAL },

  // Channel doorways bind an inbound integration to an agent and store its
  // provider credentials. Rotation reveals a fresh plaintext webhook secret.
  { pattern: "channels.create", minimum: APPROVAL },
  { pattern: "channels.update", minimum: APPROVAL },
  { pattern: "channels.delete", minimum: APPROVAL },
  { pattern: "channels.rotate_webhook_secret", minimum: APPROVAL },
  // Strictly more powerful than `channels.create`: it also mints the external
  // app and stores the secrets that come back.
  { pattern: "channels.mint_from_manifest", minimum: APPROVAL },

  // Marketplace channel apps are installed into N external workspaces, so
  // every write here has cross-tenant blast radius.
  { pattern: "channel_apps.create", minimum: APPROVAL },
  { pattern: "channel_apps.update", minimum: APPROVAL },
  { pattern: "channel_apps.delete", minimum: APPROVAL },
  { pattern: "channel_apps.bind_installation", minimum: APPROVAL },
  { pattern: "channel_apps.import_installation", minimum: APPROVAL },
  { pattern: "channel_apps.revoke_installation", minimum: APPROVAL },

  // Knowledge graph. Deleting a node cascades every edge touching it;
  // discovery walks a quadratic candidate set and can materialise edges.
  { pattern: "kg.delete_node", minimum: APPROVAL },
  { pattern: "kg.discover_links", minimum: APPROVAL },

  // Skill library management reaches every agent in scope at once.
  { pattern: "skills.update", minimum: APPROVAL },
  { pattern: "skills.disable_globally", minimum: APPROVAL },
  { pattern: "skills.uninstall", minimum: APPROVAL },

  // Organization membership. Last-admin protection lives in the tool; the gate
  // is here because an invite is cross-tenant.
  { pattern: "org.update", minimum: APPROVAL },
  { pattern: "org.add_member", minimum: APPROVAL },
  { pattern: "org.remove_member", minimum: APPROVAL },
  { pattern: "org.set_member_role", minimum: APPROVAL },

  // Environments and their secrets.
  { pattern: "environments.create", minimum: APPROVAL },
  { pattern: "environments.delete", minimum: APPROVAL },
  { pattern: "environments.set_secret", minimum: APPROVAL },
  { pattern: "environments.delete_secret", minimum: APPROVAL },

  // Clusters alter cross-agent memory and thread visibility.
  { pattern: "clusters.create", minimum: APPROVAL },
  { pattern: "clusters.add_agent", minimum: APPROVAL },
]);

/**
 * The baseline for one tool name, or `auto_allow` when nothing covers it.
 *
 * FIRST MATCH WINS, AND THE TABLE DOES OVERLAP. `gdpr.*` covers
 * `gdpr.export_user_everywhere`, which is also listed on its own under the
 * cross-scope group. That is harmless only because every overlapping pair
 * agrees on its minimum, which makes first-match and strictest-match the same
 * function and the table's ORDER not load-bearing. `permission.test.ts` pins
 * that agreement, so a future entry that disagreed with a pattern above it
 * fails rather than silently depending on where it was typed.
 */
export function platformMinimumFor(toolName: string): PermissionState {
  for (const rule of PLATFORM_TIER_MINIMUMS) {
    if (matchesPattern(rule.pattern, toolName)) return rule.minimum;
  }
  return "auto_allow";
}
