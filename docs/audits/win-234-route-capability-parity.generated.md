# WIN-234 / WIN-238 route and capability parity matrix (generated)

> Generated from `docs/audits/win-234-route-capability-parity.json`. Do not edit by hand; run `pnpm generate:route-parity`.

This prerequisite is an explicit audit contract, not a completion claim. `required-not-verified` and `confirmed-defect` rows remain visible until persisted-state and authenticated-browser evidence replaces them.

## Baselines

- Current: `f5793473a2ddfda5b0d20ba6163e551ac7961028` — **84** executable routes.
- v0 archaeology: `c7902ec22a03f7c60240c8d319f756e548fe5ec8` — **429** total route-tree files, **428** TypeScript files, **427** verified TypeScript route modules after excluding exactly `apps/webapp/app/routes/projects.v3.$projectRef.test.ts`, and **1** non-TypeScript file.
- Capability rows: **107**, keyed by `current_route + capability_id`.
- Inventory/schema gate: `pnpm audit:route-parity` (CI-safe while explicit defects and missing evidence remain recorded).
- Completion gate: `pnpm audit:route-parity:completion` (expected red until every retained capability is complete).

## Design inputs

| Source | Kind | Availability | SHA-256 |
|---|---|---|---|
| `/code/.plans/designs/design-plan.json` | file | verify-when-present | `a5ebf0af5e98c9db3f4472b4a936b37512a24791323698a1e8e08ec606a0d621` |
| `/code/.plans/designs/win233-visual-rebirth-audit.md` | file | verify-when-present | `557b984828cef7f09186b1fb5d5bf55aa29f6263686dece2cb7d7cd60d96ff89` |
| `design/platos-ui-refactor` | tree | required | `619177dc3434f216a144d6add26f42351cfba9039c979aff0351b05e2edcbd13` |
| `apps/webapp/app/components/platos/referenceRouteManifest.ts` | file | required | `3ab7d33755d9f5d532a5cfa80647024b7ea1c842f4a1119ad86d0e32a68c50fd` |

## Disposition summary

| Inventory | Disposition | Rows |
|---|---|---:|
| current routes | improve | 71 |
| current routes | redirect | 13 |
| v0 routes | improve | 59 |
| v0 routes | intentional-removal | 286 |
| v0 routes | redirect | 20 |
| v0 routes | requires-product-decision | 62 |

## Current route capabilities

| Current route | Capability ID | Disposition | HTTP contracts | Read-back | Defect | Automated evidence | Browser evidence |
|---|---|---|---|---|---|---|---|
| `apps/webapp/app/routes/_app/route.tsx` | `route-001` | improve | NONE Route module apps/webapp/app/routes/_app/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app._index/route.tsx` | `route-002` | redirect | NONE Route module apps/webapp/app/routes/_app._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug/route.tsx` | `route-003` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx` | `route-004` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx` | `route-005` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx` | `route-006` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route.tsx` | `route-007` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx` | `route-008` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route.tsx` | `route-009` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx` | `route-010` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters.$clusterId/route.tsx` | `route-011` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters.$clusterId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx` | `route-012` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect/route.tsx` | `route-013` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect.channels.ts` | `route-014` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect.channels.ts | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx` | `route-015` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.initial-secret/route.tsx` | `route-016` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.initial-secret/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.wire-test/route.tsx` | `route-017` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.wire-test/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx` | `route-018` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx` | `mcp-credential-reference-migration` | improve | POST /api/v1/agent/entities | required-not-verified | required-not-verified | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx` | `route-019` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx` | `route-020` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-governance._index/route.tsx` | `route-021` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-governance._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx` | `route-022` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx` | `route-023` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx` | `route-024` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx` | `route-025` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId/route.tsx` | `route-026` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx` | `route-027` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx` | `route-028` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` | `attachment-presign-upload` | improve | POST /api/v1/agent/attachments/presigned | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` | `message-rating-lifecycle` | improve | GET /api/v1/agent/messages/:messageId/rating; POST /api/v1/agent/messages/:messageId/rating; DELETE /api/v1/agent/messages/:messageId/rating | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` | `route-029` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx` | `route-030` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId/route.tsx` | `route-031` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route.tsx` | `route-032` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx` | `route-033` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx` | `postman-executable-mode` | improve | POST /api/v1/agent/postman-templates/:id/execute | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx` | `postman-template-crud` | improve | GET /api/v1/agent/postman-templates?agentId=:agentId; POST /api/v1/agent/postman-templates; PUT /api/v1/agent/postman-templates/:id; DELETE /api/v1/agent/postman-templates/:id | required-not-verified | required-not-verified | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx` | `route-034` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx` | `route-035` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.skills/route.tsx` | `route-036` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.skills/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx` | `agent-tools-loader-action-mismatch` | improve | GET /api/v1/agent/agents/:agentId/tool-mappings; PATCH /api/v1/agent/agents/:agentId/tool-mappings/:toolId | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx` | `route-037` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx` | `route-038` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx` | `route-039` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index/route.tsx` | `route-040` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx` | `route-041` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `access-key-allowed-origins` | improve | POST /api/v1/agent/access-key/origins | required-not-verified | required-not-verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `access-key-browser-request-correlation` | improve | POST /api/v1/agent/access-key | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `access-key-one-time-reveal` | improve | POST /api/v1/agent/access-key | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `access-key-revoke` | improve | DELETE /api/v1/agent/access-key | required-not-verified | required-not-verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `access-key-rotation-correlation` | improve | GET /api/v1/agent/access-key; POST /api/v1/agent/access-key | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | `route-042` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId/route.tsx` | `route-043` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx` | `route-044` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.audit/route.tsx` | `route-045` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.audit/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.cost/route.tsx` | `route-046` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.cost/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx` | `route-047` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx` | `route-048` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx` | `route-049` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users/route.tsx` | `route-050` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations/route.tsx` | `route-051` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations.$threadId.attachments/route.tsx` | `route-052` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations.$threadId.attachments/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx` | `route-053` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `entity-mcp-bearer-token-create` | improve | POST /mcp/entity/:entityId/tokens | required-not-verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `entity-mcp-bearer-token-delete` | improve | DELETE /mcp/entity/:entityId/tokens/:tokenId | required-not-verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `entity-mcp-bearer-token-list` | improve | GET /mcp/entity/:entityId/tokens | required-not-verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `mcp-combined-identity-modes` | improve | PATCH /mcp/entity/:entityId/config | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `mcp-identity-context` | improve | PATCH /mcp/entity/:entityId/config | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `mcp-tool-acl-policy` | improve | GET /mcp/entity/:entityId/tool-acl; PATCH /mcp/entity/:entityId/tool-acl/:toolId; POST /mcp/entity/:entityId/tool-acl/bulk | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | `route-054` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` | `mcp-token-create` | improve | POST /mcp/platform/tokens | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` | `mcp-token-list` | improve | GET /mcp/platform/tokens | not-applicable | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` | `mcp-token-revoke` | improve | POST /mcp/platform/tokens/:id/revoke | required-not-verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` | `route-055` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx` | `route-056` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.export/route.tsx` | `route-057` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.export/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route.tsx` | `route-058` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId/route.tsx` | `route-059` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx` | `route-060` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx` | `route-061` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings/route.tsx` | `route-062` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route.tsx` | `route-063` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx` | `route-064` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx` | `route-065` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills._index/route.tsx` | `route-066` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new/route.tsx` | `route-067` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx` | `message-pagination` | improve | GET /api/v1/agent/threads/:threadId/messages | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx` | `route-068` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx` | `thread-artifacts` | improve | GET /api/v1/agent/threads/:threadId/artifacts | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx` | `thread-fork` | improve | POST /api/v1/agent/threads/:threadId/fork | verified | verified | verified | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId.trace/route.tsx` | `route-069` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId.trace/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads._index/route.tsx` | `route-070` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings/route.tsx` | `route-071` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.settings/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings._index/route.tsx` | `route-072` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.settings._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx` | `route-073` | improve | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx` | `route-074` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/_app.orgs.new/route.tsx` | `route-075` | redirect | NONE Route module apps/webapp/app/routes/_app.orgs.new/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/account/route.tsx` | `route-076` | improve | NONE Route module apps/webapp/app/routes/account/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/account._index/route.tsx` | `route-077` | improve | NONE Route module apps/webapp/app/routes/account._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/api.v1.public.agents.$agentId.chat.stream.ts` | `route-078` | improve | NONE Route module apps/webapp/app/routes/api.v1.public.agents.$agentId.chat.stream.ts | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/api.v1.public.guest-token.ts` | `route-079` | improve | NONE Route module apps/webapp/app/routes/api.v1.public.guest-token.ts | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/embed.$agentId.tsx` | `route-080` | improve | NONE Route module apps/webapp/app/routes/embed.$agentId.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/healthcheck.tsx` | `route-081` | improve | NONE Route module apps/webapp/app/routes/healthcheck.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/login._index/route.tsx` | `route-082` | redirect | NONE Route module apps/webapp/app/routes/login._index/route.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/logout.tsx` | `route-083` | redirect | NONE Route module apps/webapp/app/routes/logout.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |
| `apps/webapp/app/routes/magic.tsx` | `route-084` | redirect | NONE Route module apps/webapp/app/routes/magic.tsx | not-applicable | static-contract-only | static-contract-only | required-not-verified |

## Completion gate status (expected red)

| Blocker category | Count | Requirement |
|---|---:|---|
| permission | 96 | Verify permission behavior or record an approved not-applicable/justified-exclusion status. |
| organization scope | 84 | Verify Organization isolation or record an approved not-applicable status. |
| project scope | 84 | Verify Project isolation or record an approved not-applicable status. |
| environment scope | 84 | Verify Environment isolation or record an approved not-applicable status. |
| EndUser scope | 2 | Verify EndUser isolation or record an approved not-applicable status. |
| Agent scope | 19 | Verify Agent isolation or record an approved not-applicable status. |
| cluster scope | 1 | Verify cluster isolation or record an approved not-applicable status. |
| form behavior | 47 | Verify form behavior or record an approved redirect/not-applicable status. |
| link behavior | 105 | Verify link and deep-link behavior or record an approved redirect/not-applicable status. |
| destructive confirmation | 12 | Verify destructive confirmation or record an approved not-applicable/justified-exclusion status. |
| idempotency | 19 | Verify replay and duplicate-submission behavior or record an approved not-applicable/justified-exclusion status. |
| concurrency | 18 | Verify concurrent behavior or record an approved not-applicable/justified-exclusion status. |
| recovery | 101 | Verify failure, retry, and unavailable-backend recovery or record an approved not-applicable/justified-exclusion status. |
| secret exposure | 102 | Verify secret-safe payloads, errors, logs, storage, and snapshots or record an approved not-applicable/justified-exclusion status. |
| persisted-state evidence | 9 | Provide create/update/delete/read-back evidence against the canonical clean-schema owner. |
| automated behavioral evidence | 86 | Replace static or pending references with passing behavioral test evidence. |
| browser evidence | 107 | Provide authenticated browser evidence or a source-backed justified exclusion. |
| pagination and totals | 1 | Prove complete totals and usable pagination/virtualization for dense retained data. |

## v0 archaeology by family

### agent-config (4)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx` / `route-027` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId/route.tsx` / `route-026` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index/route.tsx` / `route-040` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx` / `route-041` | Path-identical current route is retained for deliberate improvement or redirect. |

### agent-context-skills-tools (5)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx` / `route-030` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.skills/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.skills/route.tsx` / `route-036` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx` / `route-037` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills._index/route.tsx` / `route-066` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new/route.tsx` / `route-067` | Path-identical current route is retained for deliberate improvement or redirect. |

### ambiguous-legacy (11)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.prompts.$slug.override.reactivate.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.prompts.$slug.override.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.prompts.$slug.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.prompts.$slug.versions.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.prompts._index.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.user.pat.$id.revoke.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.user.pat.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v1.whoami.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/api.v2.whoami.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/confirm-basic-details.tsx` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |
| `apps/webapp/app/routes/resources.agent.ts` | requires-product-decision | — | No statically unambiguous Trigger-removal or canonical Platos mapping was found; product disposition is required. |

### connect-share-accounts-jobs (7)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect/route.tsx` / `route-013` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx` / `route-035` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx` / `route-053` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId/route.tsx` / `route-059` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx` / `route-060` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx` / `route-061` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/embed.$agentId.tsx` | improve | `apps/webapp/app/routes/embed.$agentId.tsx` / `route-080` | Path-identical current route is retained for deliberate improvement or redirect. |

### entities-mcp-memory (11)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters.$clusterId/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters.$clusterId/route.tsx` / `route-011` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx` / `route-012` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.initial-secret/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.initial-secret/route.tsx` / `route-016` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.wire-test/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.wire-test/route.tsx` / `route-017` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx` / `route-015` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx` / `route-018` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx` / `route-019` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx` / `route-054` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx` / `route-055` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx` / `route-056` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route.tsx` / `route-058` | Path-identical current route is retained for deliberate improvement or redirect. |

### entity-compatibility-shim (3)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs.$orgId/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx` / `route-015` | v0 source explicitly labels this a backwards-compatibility 307 redirect from agent-orgs to canonical agent-entities, preserving method/body where applicable. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs._index/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx` / `route-018` | v0 source explicitly labels this a backwards-compatibility 307 redirect from agent-orgs to canonical agent-entities, preserving method/body where applicable. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs.new/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx` / `route-019` | v0 source explicitly labels this a backwards-compatibility 307 redirect from agent-orgs to canonical agent-entities, preserving method/body where applicable. |

### evals-versions-governance (8)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx` / `route-020` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-governance._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-governance._index/route.tsx` / `route-021` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx` / `route-028` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx` / `route-033` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx` / `route-039` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId/route.tsx` / `route-043` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx` / `route-044` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx` / `route-049` | Path-identical current route is retained for deliberate improvement or redirect. |

### foundation-tenancy-settings (29)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app._index/route.tsx` | redirect | `apps/webapp/app/routes/_app._index/route.tsx` / `route-002` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx` / `route-004` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx` / `route-005` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam._index/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx` / `route-006` | Legacy route has an explicit current canonical target; preserve only redirect semantics, not legacy ownership. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam._index/route.tsx` / `route-008` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx` / `route-042` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx` / `route-048` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx` / `route-047` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route.tsx` / `route-063` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations._index/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx` / `route-064` | Legacy route has an explicit current canonical target; preserve only redirect semantics, not legacy ownership. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx` / `route-065` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx` / `route-064` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings/route.tsx` / `route-062` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route.tsx` / `route-007` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx` / `route-006` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings._index/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings._index/route.tsx` / `route-072` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx` / `route-073` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings/route.tsx` / `route-071` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug/route.tsx` / `route-003` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx` / `route-074` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.new/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.new/route.tsx` / `route-075` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app/route.tsx` | improve | `apps/webapp/app/routes/_app/route.tsx` / `route-001` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/account._index/route.tsx` | improve | `apps/webapp/app/routes/account._index/route.tsx` / `route-077` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/account/route.tsx` | improve | `apps/webapp/app/routes/account/route.tsx` / `route-076` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/healthcheck.tsx` | improve | `apps/webapp/app/routes/healthcheck.tsx` / `route-081` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/login._index/route.tsx` | redirect | `apps/webapp/app/routes/login._index/route.tsx` / `route-082` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/login.magic/route.tsx` | redirect | `apps/webapp/app/routes/magic.tsx` / `route-084` | Legacy route has an explicit current canonical target; preserve only redirect semantics, not legacy ownership. |
| `apps/webapp/app/routes/logout.tsx` | redirect | `apps/webapp/app/routes/logout.tsx` / `route-083` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/magic.tsx` | redirect | `apps/webapp/app/routes/magic.tsx` / `route-084` | Path-identical current route is retained for deliberate improvement or redirect. |

### legacy-auth-account (14)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.account.api-tokens._index/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/account.authorization-code.$authorizationCode/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/account.security/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/account.tokens/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/api.v1.auth.jwt.claims.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/api.v1.auth.jwt.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/api.v1.authorization-code.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/auth.google.callback.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/auth.google.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/oauth.consent/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/resources.account.mfa.setup/MfaToggle.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/resources.account.mfa.setup/route.tsx` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/resources.account.mfa.setup/useMfaSetup.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |
| `apps/webapp/app/routes/resources.impersonation.ts` | requires-product-decision | — | Legacy auth/account route is not path-identical to the clean operator contract; security and redirect ownership require a product decision. |

### legacy-integration (1)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/integrations.$serviceName.callback.ts` | requires-product-decision | — | Integration route is not proven Trigger-only or canonically retained; product ownership requires a decision. |

### legacy-tenancy (32)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.@.orgs.$organizationSlug.$.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.regions/route.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.orgs.$orgParam.projects.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.orgs.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.$env.jwt.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.$env.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.$env.workers.$tagName.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.dev-status.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.envvars.$slug.$name.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.envvars.$slug.import.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.envvars.$slug.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.envvars.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/api.v1.projects.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/invite-accept.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/invite-resend.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/invite-revoke.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/invites.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.environment-variables.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.settings.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.v3.$.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/orgs.$organizationSlug.team.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/orgs.$organizationSlug.usage.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/projects.$projectRef.ai-help.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/projects.$projectRef.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/projects.new.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/projects.v3.$projectRef.environment-variables.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/projects.v3.$projectRef.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/resources.environments.$environmentId.regenerate-api-key.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.dev.presence.tsx` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.prompts.$promptSlug.generations.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.versions.ts` | requires-product-decision | — | Legacy tenancy route has no exact current counterpart; canonical operator tenancy ownership must be decided before deletion or redirect. |

### mcp-compatibility-redirect (1)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.mcp-tokens/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx` / `route-065` | v0 source explicitly returns a 307 redirect to /settings/integrations/mcp; current route continues to redirect to the canonical MCP surface. |

### monitoring-cost-budgets (3)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx` / `route-010` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx` / `route-022` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx` / `route-023` | Path-identical current route is retained for deliberate improvement or redirect. |

### platos-legacy-unmapped (4)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.agent.attachments.$attachmentId.ts` | requires-product-decision | — | Platos-shaped legacy API capability has no exact canonical route target; endpoint ownership and migration intent require an explicit product decision. |
| `apps/webapp/app/routes/api.v1.agent.attachments.retention.ts` | requires-product-decision | — | Platos-shaped legacy API capability has no exact canonical route target; endpoint ownership and migration intent require an explicit product decision. |
| `apps/webapp/app/routes/api.v1.agent.evals.ts` | requires-product-decision | — | Platos-shaped legacy API capability has no exact canonical route target; endpoint ownership and migration intent require an explicit product decision. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.apikeys.ts` | requires-product-decision | — | Platos-shaped legacy capability has no exact canonical target; product ownership and migration intent must be decided explicitly. |

### registry-providers (2)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx` / `route-024` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx` / `route-025` | Path-identical current route is retained for deliberate improvement or redirect. |

### security-deletion (1)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect.mint-token.ts` | intentional-removal | — | Explicit security deletion: the v0 dev-only endpoint minted five-minute Platos session tokens from PLATOS_SESSION_SECRET behind PLATOS_TEST_MODE and must not exist or redirect in production. |

### threads-chat-traces (6)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` / `route-029` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId/route.tsx` / `route-031` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route.tsx` / `route-032` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx` / `route-034` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx` | redirect | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx` / `route-038` | Path-identical current route is retained for deliberate improvement or redirect. |
| `apps/webapp/app/routes/api.v1.agent.attachments.presigned.ts` | improve | `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx` / `attachment-presign-upload` | Retain and improve attachment presign/upload against canonical MessageAttachment and object-store ownership; current chat accepts attachmentIds but lacks the presign control. |

### trigger-branches (4)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.branches.archive.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.branches.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.branches.archive.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-deployments-workers (22)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.background-workers.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.cancel.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.fail.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.finalize.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.generate-registry-credentials.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.progress.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.$deploymentVersion.promote.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.latest.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.deployments.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.background-workers.$envSlug.$version.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.background-workers.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.prompts.$slug.promote.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v2.deployments.$deploymentId.finalize.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v3.deployments.$deploymentId.finalize.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/deployments.$deploymentParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.deployments.$deploymentParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/projects.v3.$projectRef.deployments.$deploymentParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.$projectId.deployments.$deploymentId.logs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.$projectId.deployments.$deploymentShortCode.cancel.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.$projectId.deployments.$deploymentShortCode.promote.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.$projectId.deployments.$deploymentShortCode.rollback.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-dev-only (4)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.mock.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/internal.webhooks.tester.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/tests.sse.stream.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/tests.sse.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-engine-runtime (31)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/admin.api.v1.workers.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.idempotencyKeys.$key.reset.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.remote-build-provider-status.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.token.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.workers.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.config.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.dequeue.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.disconnect.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.presence.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.runs.$runFriendlyId.logs.debug.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.attempts.complete.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.attempts.start.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.heartbeat.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.latest.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.runs.$runFriendlyId.wait.duration.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.runs.$runFriendlyId.waitpoints.tokens.$waitpointFriendlyId.wait.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.connect.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.deployments.$deploymentFriendlyId.dequeue.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.dequeue.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.heartbeat.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.logs.debug.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.attempts.complete.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.attempts.start.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.continue.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.heartbeat.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.suspend.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.latest.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.since.$snapshotId.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/otel.v1.traces.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/sync.traces.$traceId.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/sync.traces.runs.$traceId.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-hosted-docs (5)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.public.docs.$slug.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.public.docs._index.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.public.guides.$slug.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.public.guides._index.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.public.search.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-hosted-platform (58)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationId.subscription.v3.canceled/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationId.subscription.v3.complete/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationId.subscription.v3.failed/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationId.subscription.v3.free_connect_failed/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationId.subscription.v3.free_connect_success/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.billing-alerts/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.billing/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.usage/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug_.select-plan/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.timezones/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin._index.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.environments.$environmentId.engine.report.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.environments.$environmentId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.feature-flags.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.gc.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.llm-models.$modelId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.llm-models.missing.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.llm-models.reload.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.llm-models.seed.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.llm-models.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.orgs.$organizationId.environments.staging.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.orgs.$organizationId.feature-flags.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.platform-notifications.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.$batchId.backfill.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.$batchId.cancel.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.backfill.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.create.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.start.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.stop.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.runs-replication.teardown.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.simulate-error.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.snapshot.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v2.orgs.$organizationId.feature-flags.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.feature-flags.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.llm-models.$modelId.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.llm-models._index.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.llm-models.missing.$model.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.llm-models.missing._index.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.llm-models.new.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.notifications.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.orgs.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.admin.users.$userId.data.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.artifacts.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.platform-notifications.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.timezones.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.usage.ingest.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/orgs.$organizationSlug.billing.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.$organizationSlug.subscription.portal.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.feedback.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.select-plan.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.platform-notifications.$id.clicked.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.platform-notifications.$id.dismiss.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.platform-notifications.$id.seen.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.platform-notifications.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.preferences.sidemenu.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.timezone.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/unsubscribe.$userId.$token.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-integrations (17)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.github.callback/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.github.install/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.integrations.slack.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.integrations.vercel.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.private-connections._index/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.private-connections.new/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.orgs.$organizationSlug.projects.$projectParam.vercel.projects.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/auth.github.callback.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/auth.github.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/internal.webhooks.slack.interactivity.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.vercel.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/vercel.callback.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/vercel.configure.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/vercel.connect.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/vercel.install.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/vercel.onboarding.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-packets-logs-dashboards (20)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/api.v1.packets.$.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.alertChannels.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v2.packets.$.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/login.mfa/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/metrics.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/otel.v1.logs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/otel.v1.metrics.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/projects.v3.$projectRef.metrics/registerProjectMetrics.server.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/projects.v3.$projectRef.metrics/route.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.account.mfa.setup/MfaDisableDialog.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.account.mfa.setup/MfaSetupDialog.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.incidents.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.metric.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.can-view-logs-page/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboards.$dashboardId.widgets.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboards.create.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.$logId.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.logs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.packets.$environmentId.$.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.platform-changelogs.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-queues-concurrency (18)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.concurrency/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.limits/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.environments.$environmentId.engine.repair-queues.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.migrate-legacy-master-queues.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.orgs.$organizationId.concurrency.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.queues.$queueParam.concurrency.override.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.queues.$queueParam.concurrency.reset.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.queues.$queueParam.pause.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.queues.$queueParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.queues.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.complete.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.waitpoints.tokens.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.concurrency.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tags.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-runs-tasks (52)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/@.runs.$runParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.stream/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/AgentContextCard.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/BatchRunView.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.tasks._index/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.tasks.stream/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/admin.api.v1.orgs.$organizationId.runs.enable.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.batches.$batchId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.batches.$batchParam.results.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.projects.$projectRef.runs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runFriendlyId.input-streams.wait.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runId.events.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runId.metadata.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runId.spans.$spanId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runId.tags.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runId.trace.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runParam.replay.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runParam.reschedule.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.$runParam.result.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.runs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v2.batches.$batchId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v2.runs.$runParam.cancel.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v2.tasks.batch.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v3.batches.$batchId.items.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v3.batches.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v3.runs.$runId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/orgs.$organizationSlug.projects.$projectParam.runs.$runParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/projects.v3.$projectRef.runs.$runParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/projects.v3.$projectRef.runs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.batches.$batchId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.runs.$runId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.runs.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.streams.$runId.$streamId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.streams.$runId.$target.$streamId.append.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.streams.$runId.$target.$streamId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/realtime.v1.streams.$runId.input.$streamId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.environments.$envId.runs.tags.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.idempotencyKey.reset.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.ai-filter.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.runs.$runParam.logs.download.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.runs.$runParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.taskruns.$runParam.cancel.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.taskruns.$runParam.debug.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.taskruns.$runParam.replay.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/runs.$runParam.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-schedules (7)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/admin.api.v1.environments.$environmentId.schedules.recover.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.schedules.$scheduleId.activate.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.schedules.$scheduleId.deactivate.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.schedules.$scheduleId.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/api.v1.schedules.ts` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.schedules.new.natural-language.tsx` | intentional-removal | — | Explicit Trigger-derived or hosted-platform family; removal is intentional and the route must not be resurrected. |

### trigger-shell (1)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/@.ts` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-storybook (45)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/storybook.animated-panel/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.avatar/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.badges/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.buttons/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.callout/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.charts/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.checkboxes/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.clipboard-field/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.code-block/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.date-fields/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.detail-cell/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.dialog/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.environment-label/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.filter/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.free-plan-usage/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.info-panel/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.inline-code/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.input-fields/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.loading-bar-divider/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.page-header/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.popover/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.pricing-callout/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.radio-group/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.resizable/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.run-and-span-timeline/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.search-fields/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.segmented-control/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.select/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.shortcuts/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.simple-form/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.spinner/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.stepper/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.switch/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.table/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.tabs.$tabNumber/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.tabs/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.textarea/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.timeline/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.toast/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.tooltip/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.tree-view/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.tsql-editor/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.typography/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook.unordered-list/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |
| `apps/webapp/app/routes/storybook/route.tsx` | intentional-removal | — | Explicit Trigger-derived, hosted, engine, or development-only family; removal is intentional and the route must not be resurrected. |

### trigger-task-payload-generation (1)

| v0 source | Disposition | Current target / capability | Rationale |
|---|---|---|---|
| `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.ai-generate-payload.tsx` | intentional-removal | — | Production .test. URL-segment route is Trigger task/deployment payload generation and is intentionally removed; it is not a collocated test module. |

## Evidence semantics

- `static-contract-only`: exact source, method, endpoint, DTO, scope, or model evidence is recorded, but runtime behavior is not claimed.
- `required-not-verified`: mandatory persisted-state or authenticated-browser evidence remains outstanding.
- `confirmed-defect`: source proves a contract mismatch or absent retained interaction; the row must remain blocking until repaired and read back.
- `requires-product-decision`: reserved for legacy behavior whose source and canonical ownership do not resolve a safe disposition.
- `intentional-removal`: explicit Trigger-derived or security-deleted behavior that must not be resurrected.
