// WIN-259 — the fixture this gate rotates, registered through the composed
// contracts rather than as SQL.
//
// WHY IT IS A SEPARATE PROCESS. The corpus the scan reads must be the SERVING
// process's own stdout — `apps/core-api/dist/main.js`, the shipped entry point,
// started the way an orchestrator starts it. That process has no route that
// creates a provider key (`POST /api/v1/agent/providers/keys` is served by
// apps/agent), so the key has to be registered by something else, and anything
// registering it inside the serving process would put fixture work in the stream
// under examination.
//
// So this runs first, against the same database and the same encryption key,
// composes the application exactly as `main.ts` does, registers the key through
// `providers.registerProviderKey` — the path a real operator's key is created by,
// including the `CredentialSecretVersion` a rotation counts from — and exits.
// Its own output is NOT part of the corpus, which is stated here rather than
// left for a reader to infer.
//
// Run: node tests/log-secret-scan/seed.mjs <output.json>
// Configuration comes from the environment, exactly as the deployable's does.

import { writeFileSync } from "node:fs";

// Deep import rather than the bare specifier: `tests/` is not a workspace
// package, so nothing links `@platos/kernel` into a node_modules it can see,
// and adding a root dependency would move the webapp image's SBOM receipt.
import { asIdentifier } from "../../packages/kernel/dist/index.js";

import { constructAdapters } from "../../apps/core-api/dist/composition/adapter-bindings.js";
import { assembleContextPorts } from "../../apps/core-api/dist/composition/context-ports.js";
import { loadPlatformConfiguration } from "../../apps/core-api/dist/config/platform.js";
import { createProcessDefaults, startCoreApi } from "../../apps/core-api/dist/runtime/lifecycle.js";

const AT = new Date("2026-09-16T00:00:00.000Z");

const IDS = {
  organization: "dddddddd-0001-4000-8000-000000000001",
  project: "dddddddd-0002-4000-8000-000000000002",
  environment: "dddddddd-0003-4000-8000-000000000003",
  entity: "dddddddd-0004-4000-8000-000000000004",
  user: "dddddddd-0101-4000-8000-000000000101",
  membership: "dddddddd-0201-4000-8000-000000000201",
};

const OPERATOR_EMAIL = "log-scan-operator@platos.win259.test";

async function main() {
  const out = process.argv[2];
  if (out === undefined) throw new Error("usage: seed.mjs <output.json>");
  const original = process.env["PLATOS_LOG_SCAN_ORIGINAL_KEY_SECRET"];
  if (original === undefined || original === "") throw new Error("PLATOS_LOG_SCAN_ORIGINAL_KEY_SECRET is required");

  const platform = loadPlatformConfiguration(process.env);
  if (!platform.ok) throw new Error(`platform configuration refused: ${JSON.stringify(platform.diagnostics)}`);
  const defaults = createProcessDefaults(platform.value.core);
  const construction = constructAdapters({
    stores: platform.value.stores,
    security: platform.value.security,
    providers: platform.value.providers,
    channels: platform.value.channels,
    clock: defaults.clock,
    correlation: null,
  });
  if (construction.faults.length > 0) throw new Error(construction.faults.join("; "));
  const assembly = assembleContextPorts(construction.adapters, defaults);
  const store = construction.adapters["postgres-tenancy"];
  if (store === undefined) throw new Error("postgres-tenancy must be constructed");

  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganization(
      { id: asIdentifier(IDS.organization), slug: asIdentifier("win259-log-scan"), name: "Log scan", archivedAt: null, createdAt: AT, updatedAt: AT },
      transaction,
    );
    await store.saveProject(
      { id: asIdentifier(IDS.project), organizationId: asIdentifier(IDS.organization), slug: asIdentifier("scan"), name: "Scan", archivedAt: null, createdAt: AT, updatedAt: AT },
      transaction,
    );
    await store.saveEnvironment(
      {
        id: asIdentifier(IDS.environment),
        projectId: asIdentifier(IDS.project),
        slug: asIdentifier("prod"),
        name: "Production",
        archivedAt: null,
        accessKeyRevocationVersion: 0,
        memoryFeedbackBackfillCursor: null,
        memoryFeedbackBackfillCompletedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
    await store.saveEntity(
      {
        id: asIdentifier(IDS.entity),
        projectId: asIdentifier(IDS.project),
        externalId: "log-scan-desk",
        displayName: "Log scan desk",
        connectionStatus: "connected",
        connectionKind: "mcp",
        mcpUrls: [],
        allowedOrigins: [],
        capabilities: [],
        lastConnectedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
      transaction,
    );
  });
  await store.users.upsertByEmail(asIdentifier(OPERATOR_EMAIL), asIdentifier(IDS.user));
  await store.unitOfWork.run(async (transaction) => {
    await store.saveOrganizationMembership(
      { id: asIdentifier(IDS.membership), organizationId: asIdentifier(IDS.organization), userId: asIdentifier(IDS.user), role: "OWNER", deactivatedAt: null, createdAt: AT, updatedAt: AT },
      transaction,
    );
  });

  const running = await startCoreApi({
    configuration: { ...platform.value.core, port: 0 },
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
  });
  try {
    const providers = running.app.contexts.providers;
    const tenancy = running.app.contexts.tenancy;
    if (providers === undefined || tenancy === undefined) throw new Error("providers and tenancy must both be composed");
    const grant = await tenancy.authorizeEnvironmentOperator({
      environmentId: asIdentifier(IDS.environment),
      operator: { actorUserId: asIdentifier(IDS.user), effectiveUserId: asIdentifier(IDS.user) },
      access: "secret:mutate",
    });
    if (!grant.ok) throw new Error(`seed authorization refused: ${grant.error.code}`);
    const registered = await providers.registerProviderKey({
      authorization: grant.value,
      intake: { provider: "anthropic", label: "log scan rotating key", credentialName: "log-scan-key", isDefault: true },
      plaintext: original,
    });
    if (!registered.ok) throw new Error(`seed registration refused: ${registered.error.code}`);
    writeFileSync(out, `${JSON.stringify({ ...IDS, operatorEmail: OPERATOR_EMAIL, providerKeyId: registered.value.providerKeyId }, null, 2)}\n`);
  } finally {
    await running.stop("seed");
    await construction.release();
    await assembly.release();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`seed failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
