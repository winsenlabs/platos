-- Sixteen complete tenants, for the `tools` integration suites.
--
-- WHY THIS IS SQL AND NOT CODE, AND IT IS NOT CONVENIENCE. Seven of the rows a
-- `tools` suite needs belong to three OTHER contexts — `Agent`, `AgentVersion`
-- and `AgentBinding` to `agents`; `Thread`, `Turn` and `Step` to
-- `conversations`; `Credential` to `secrets` — and ADR M0.3 §1 makes each of
-- those contexts the SOLE WRITER of its rows.
-- `scripts/arch/sole-writer.mjs` enforces that per WRITE, and it refused all
-- seven when the harness wrote them from TypeScript:
--
--   FAIL src/tools-harness.ts:148 — Agent.$executeRawUnsafe: insert into() may
--   be called only from packages/contexts/agents; agents is its sole writer
--
-- That refusal is CORRECT and it is not being worked around. This adapter is the
-- canonical store for `tenancy`, `identity-access`, the kernel outbox and now
-- `tools`, and for nothing else; a fixture is not a store. The precedent and the
-- mechanism are `fixtures/identity-access-rows.sql`, applied by
-- `prisma db execute`, which needs no code path in a package at all — and, being
-- a fixture rather than a repository, makes no claim to be a writer of anything.
--
-- WHY SIXTEEN, AND WHY PRE-SEEDED RATHER THAN MINTED PER CASE. A case cannot
-- mint one for the reason above, so the suites CLAIM the next unused tenant
-- instead. Sixteen is the largest number any one suite file needs (the statement
-- suite claims nine) with room to add cases.
--
-- WHAT MAKES EACH TENANT COHERENT, and every one of these is an ancestry rule
-- in the migrations rather than a rule in `schema.prisma`:
--
--   `EnvironmentEntityTool_ancestry` and `EntityToolPolicy_ancestry` — the
--   entity must be in the environment's project.
--   `EntityMcpClient_ancestry` — the credential's environment's project must be
--   the entity's project.
--   `Thread_ancestry` — the agent must be in the environment's project AND the
--   end user in that project's organization.
--   `ToolCallAudit_ancestry` — the same, for every optional key it carries.
--
-- Every one of them FIRES ON UPDATE as well as INSERT.
--
-- THE IDENTIFIERS ARE DERIVED, NOT TYPED. `d0d0d0d0-0000-4000-8000-KKKKIIIIIIII`
-- where `KKKK` is the kind and `IIIIIIII` the index, so a uuid in a failure
-- message says which tenant and which row it is without a lookup table.

DO $tools$
DECLARE
  tenant INT;
  step_ordinal INT;
  at TIMESTAMP := '2026-05-01T09:00:00Z';
  label TEXT;
  org UUID;
  proj UUID;
  env UUID;
  wire UUID;
  mcp UUID;
  agent UUID;
  version UUID;
  end_user UUID;
  thread UUID;
  turn_row UUID;
  step_row UUID;
BEGIN
  FOR tenant IN 0..15 LOOP
    label := 'tools-' || lpad(tenant::TEXT, 2, '0');
    org := ('d0d0d0d0-0000-4000-8000-0001' || lpad(to_hex(tenant), 8, '0'))::uuid;
    proj := ('d0d0d0d0-0000-4000-8000-0002' || lpad(to_hex(tenant), 8, '0'))::uuid;
    env := ('d0d0d0d0-0000-4000-8000-0003' || lpad(to_hex(tenant), 8, '0'))::uuid;
    wire := ('d0d0d0d0-0000-4000-8000-0004' || lpad(to_hex(tenant), 8, '0'))::uuid;
    mcp := ('d0d0d0d0-0000-4000-8000-0005' || lpad(to_hex(tenant), 8, '0'))::uuid;
    agent := ('d0d0d0d0-0000-4000-8000-0006' || lpad(to_hex(tenant), 8, '0'))::uuid;
    version := ('d0d0d0d0-0000-4000-8000-0007' || lpad(to_hex(tenant), 8, '0'))::uuid;
    end_user := ('d0d0d0d0-0000-4000-8000-0009' || lpad(to_hex(tenant), 8, '0'))::uuid;
    thread := ('d0d0d0d0-0000-4000-8000-000a' || lpad(to_hex(tenant), 8, '0'))::uuid;

    INSERT INTO "Organization" ("id", "slug", "name", "createdAt", "updatedAt")
      VALUES (org, label, label, at, at);
    INSERT INTO "Project" ("id", "organizationId", "slug", "name", "createdAt", "updatedAt")
      VALUES (proj, org, label || '-project', label, at, at);
    INSERT INTO "Environment" ("id", "projectId", "slug", "name", "createdAt", "updatedAt")
      VALUES (env, proj, 'prod', 'Production', at, at);

    -- A `wire` entity, reachable at a persistent callback, and an `mcp` entity
    -- with no client row until a case writes one. `dispatchabilityOf` answers
    -- differently for the two, which is why both are here.
    INSERT INTO "Entity" ("id", "projectId", "externalId", "displayName", "connectionStatus", "connectionKind", "createdAt", "updatedAt")
      VALUES
        (wire, proj, label || '-wire', label || '-wire', 'connected', 'wire', at, at),
        (mcp, proj, label || '-mcp', label || '-mcp', 'connected', 'mcp', at, at);

    INSERT INTO "Agent" ("id", "projectId", "name", "slug", "isActive", "createdAt", "updatedAt")
      VALUES (agent, proj, label || '-agent', label || '-agent', TRUE, at, at);
    -- `toolDefaultPolicy` is NONE, so `permitsTool` is false for every tool this
    -- version never named and `allowedAgentIds` folds to the empty list. A case
    -- that wants a non-empty fold writes an `AgentToolPolicy` of its own.
    INSERT INTO "AgentVersion" ("id", "agentId", "versionNumber", "model", "toolDefaultPolicy", "createdBy", "createdAt")
      VALUES (version, agent, 1, 'test-model', 'NONE', 'fixture', at);
    INSERT INTO "AgentBinding" ("id", "environmentId", "agentId", "activeAgentVersionId", "canaryPercent", "createdAt", "updatedAt")
      VALUES (
        ('d0d0d0d0-0000-4000-8000-0008' || lpad(to_hex(tenant), 8, '0'))::uuid,
        env, agent, version, 0, at, at
      );

    INSERT INTO "EndUser" ("id", "organizationId", "displayName", "createdAt", "updatedAt")
      VALUES (end_user, org, label || '-user', at, at);
    INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "status", "createdAt", "updatedAt")
      VALUES (thread, env, agent, end_user, 'ACTIVE', at, at);

    -- A CREDENTIAL, and a name only. No secret material reaches this file: the
    -- name is all `EntityMcpClient` joins to, and `secrets` is the only holder
    -- of anything else.
    INSERT INTO "Credential" ("id", "environmentId", "kind", "name", "createdAt", "updatedAt")
      VALUES (
        ('d0d0d0d0-0000-4000-8000-000b' || lpad(to_hex(tenant), 8, '0'))::uuid,
        env, 'SERVICE_CREDENTIAL', label || '-key', at, at
      );

    -- FOUR turns and four steps per tenant. A `ToolCall` cannot exist without a
    -- `Step`, and `@@unique([stepId, sequence])` means a case that writes two
    -- calls at one sequence needs a step of its own to do it on.
    FOR step_ordinal IN 0..3 LOOP
      turn_row := ('d0d0d0d0-0000-4000-8000-0100' || lpad(to_hex(tenant * 16 + step_ordinal), 8, '0'))::uuid;
      step_row := ('d0d0d0d0-0000-4000-8000-0200' || lpad(to_hex(tenant * 16 + step_ordinal), 8, '0'))::uuid;
      INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence", "status", "createdAt")
        VALUES (turn_row, thread, version, 'CURRENT', step_ordinal + 1, 'ACTIVE', at);
      INSERT INTO "Step" ("id", "turnId", "sequence", "model", "status", "retryCount", "createdAt")
        VALUES (step_row, turn_row, 1, 'test-model', 'ACTIVE', 0, at);
    END LOOP;
  END LOOP;
END
$tools$;
