// WHY `apps/webapp` STILL HOLDS A DATABASE CREDENTIAL, EXPRESSED AS ASSERTIONS
// RATHER THAN AS PROSE.
//
// WIN-257's oldest open clause is "webapp database credentials can be removed".
// It has never been met, and the reason has been restated in four tranche briefs
// as a sentence. A sentence rots: this programme has already paid for one that
// said "419 canonical codes" while the taxonomy held 423, because nothing joined
// the prose to the file.
//
// So the blockers are joined here. Every case below reads a file this test does
// not control — the two compose topologies, the reverse proxy, the root build
// script, the webapp's env schema, and the two contracts a route may reach — and
// every failure message names what the tree change MEANS for the clause.
//
// THE POINT IS THAT THIS FILE GOES RED WHEN THE CLAUSE BECOMES REACHABLE.
// A case that fails here is not a regression. It is the news that one blocker is
// gone and the cutover can move, and it says so in its own assertion message.
//
// -----------------------------------------------------------------------------
// THE BLOCKER THAT DECIDES IT (WIN-257 T8, measured 2026-09-09)
//
// `apps/core-api` — the process that serves the whole V1 REST surface — IS NOT
// DEPLOYED ANYWHERE IN THIS REPOSITORY. It has a `main.ts` and a `start` script,
// and nothing starts it: no service in either compose file, no Dockerfile, not in
// `build:platos`, no upstream in `deploy/Caddyfile`, and no `dev` script. The
// webapp therefore cannot be cut over to it, because there is no address to call
// in any topology this repository defines. Publishing more contract methods and
// more routes does not change that, which is why T8 stopped at the keystone.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

/** The two topologies this repository ships. Neither is a fixture. */
const COMPOSE_FILES = ["docker-compose.platos.yml", "docker-compose.deploy.yml"];

/**
 * Files tracked by git, from git itself rather than from a directory walk, so a
 * build artifact left in a working tree cannot make a case pass or fail.
 */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

// ---------------------------------------------------------------------------
// BLOCKER 1 — nothing runs the V1 REST surface.
// ---------------------------------------------------------------------------

test("BLOCKER: no compose topology runs apps/core-api", () => {
  for (const file of COMPOSE_FILES) {
    const text = read(file);
    assert.equal(
      /core-api/u.test(text),
      false,
      `${file} now mentions core-api. If it runs the process, the webapp has an ` +
        `address to call for the first time: re-read WIN-257's "webapp database ` +
        `credentials can be removed" clause, because this blocker is gone.`,
    );
  }
});

test("BLOCKER: apps/core-api has no container image", () => {
  const dockerfiles = trackedFiles().filter((path) => /(^|\/)Dockerfile/u.test(path));
  // The list is asserted whole rather than probed, so a NEW deployable anywhere
  // in the tree is seen here too.
  assert.deepEqual(
    dockerfiles.sort(),
    [
      "apps/agent/Dockerfile",
      "apps/webapp/Dockerfile.platos",
      "internal-packages/tenancy-database/Dockerfile.migrations",
      "references/entity-docs-mcp-bridge/Dockerfile",
      "references/entity-hello-world/Dockerfile",
    ],
    "the set of container images changed; if one of them builds apps/core-api, " +
      "the webapp cutover blocker is gone",
  );
});

test("BLOCKER: the release build does not build apps/core-api", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const release = [scripts["build:platos"], scripts["build:platos:agent"], scripts["build:platos:webapp"]].join(" ");
  assert.equal(
    /core-api/u.test(release),
    false,
    "build:platos now builds core-api — the surface is shipping, so re-read the clause",
  );
});

test("BLOCKER: the reverse proxy has no upstream for the V1 surface", () => {
  // The Caddyfile's only upstreams are the agent (3100) and the webapp (3030).
  // core-api's port would have to appear here for a browser or a server-side
  // fetch to reach it through the edge.
  const upstreams = [...read("deploy/Caddyfile").matchAll(/reverse_proxy\s+\S+?:(\d+)/gu)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(upstreams)].sort(),
    ["3030", "3100"],
    "a third upstream appeared in deploy/Caddyfile; if it is core-api, the " +
      "webapp can reach the V1 surface and this blocker is gone",
  );
});

test("BLOCKER: apps/core-api declares no dev server either", () => {
  const scripts = JSON.parse(read("apps/core-api/package.json")).scripts;
  assert.equal(
    Object.hasOwn(scripts, "dev"),
    false,
    "apps/core-api gained a dev script; `turbo run dev` would now start it, which " +
      "is the first topology in this repository that does",
  );
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — the operations with no contract method behind them.
//
// A V1 route may reach a published contract method and nothing else. Four of the
// webapp's remaining reads have no such method, so they could not be served even
// if the process were deployed. Asserted against the CONTRACT SOURCE, so
// publishing one of them turns the corresponding case red.
// ---------------------------------------------------------------------------

const TENANCY_CONTRACT = "packages/contexts/tenancy/contracts/index.ts";

/** A method is published when the contract interface declares it. */
function declares(contractPath, method) {
  return new RegExp(`^\\s+${method}\\(`, "mu").test(read(contractPath));
}

test("BLOCKER: the four use cases the remaining webapp reads need are not published", () => {
  const missing = {
    // `_app.orgs.$slug._index` renders every visible project's environments, and
    // `_app.orgs.$slug.projects.$param` redirects into a project's FIRST one.
    // `TenancyRepository.listEnvironments` exists on the DRIVEN port; nothing
    // publishes it.
    listProjectEnvironments: "orgs/:slug and orgs/:slug/projects/:project",
    // `settings.team` lists memberships with each member's email. The email
    // needs identity-access, and the list needs a tenancy read model.
    listOrganizationMemberships: "orgs/:slug/settings/team",
    // `invite` calls PlatosAuthService.issueInvitation. The use case exists at
    // `tenancy/application/invitations.ts` and is NOT on the contract.
    issueInvitation: "orgs/:slug/invite",
    acceptInvitation: "the invitation acceptance path",
  };
  for (const [method, consumer] of Object.entries(missing)) {
    assert.equal(
      declares(TENANCY_CONTRACT, method),
      false,
      `TenancyContract now publishes ${method}. The webapp route ${consumer} can ` +
        `be served by a V1 route, so one blocker is gone — build it and re-run.`,
    );
  }
});

test("CONTROL: the use cases the cutover DOES have are published", () => {
  // Without this the case above would pass against a contract that published
  // nothing at all, which is the shape of assertion this programme has refused.
  for (const method of [
    "resolveWorkspace",
    "listOperatorOrganizations",
    "listVisibleProjects",
    "createOrganization",
    "createProject",
    "changeMembershipRole",
  ]) {
    assert.equal(declares(TENANCY_CONTRACT, method), true, `${method} must stay published`);
  }
  for (const method of ["listEnvironmentVariables", "setEnvironmentVariable"]) {
    assert.equal(
      declares("packages/contexts/secrets/contracts/index.ts", method),
      true,
      `${method} is published by secrets — the environment-variable routes are ` +
        `buildable and are NOT blocked on a contract`,
    );
  }
});

// ---------------------------------------------------------------------------
// THE CONSEQUENCE — stated where the credential actually is.
// ---------------------------------------------------------------------------

test("CONSEQUENCE: DATABASE_URL is still a required boot credential for the webapp", () => {
  const env = read("apps/webapp/app/env.server.ts");
  const line = env.split("\n").find((row) => row.includes("DATABASE_URL:"));
  assert.equal(
    line?.trim(),
    "DATABASE_URL: z.string().min(1),",
    "the webapp's DATABASE_URL declaration changed. Making it optional is the " +
      "clause's second half and must not land before the first: with core-api " +
      "undeployed, a webapp booted without it would fail on the first request " +
      "that reaches Prisma rather than at boot.",
  );
});

test("CONSEQUENCE: database.server.ts is still reachable from exactly the known importers", () => {
  assert.ok(existsSync(join(ROOT, "apps/webapp/app/services/database.server.ts")));
  const importers = trackedFiles()
    .filter((path) => path.startsWith("apps/webapp/app/") && /\.tsx?$/u.test(path))
    .filter((path) => path !== "apps/webapp/app/services/database.server.ts")
    .filter((path) => /services\/database\.server|\.\/database\.server/u.test(read(path)))
    .sort();

  // ENUMERATED, NOT COUNTED. A count would let one importer be deleted and
  // another added in the same commit without anybody seeing it.
  assert.deepEqual(importers, [
    "apps/webapp/app/routes/_app._index/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug._index/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.invite/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug_.projects.new/route.tsx",
    "apps/webapp/app/routes/_app.orgs.new/route.tsx",
    "apps/webapp/app/services/auth.server.ts",
  ]);
});

test("THE KEYSTONE IS BUILT: auth.server.ts's slug walk now has a contract method and a route", () => {
  // The one blocker WIN-257 T8 DID remove, asserted so the claim is checkable.
  assert.equal(declares(TENANCY_CONTRACT, "resolveWorkspace"), true);
  const manifest = JSON.parse(read("apps/agent/src/control-plane/operation-manifest.generated.json"));
  const workspace = manifest.inventories.restOperations.filter(
    (operation) => operation.path === "/api/v1/workspaces/:organizationSlug/:projectSlug/:environmentSlug",
  );
  assert.equal(workspace.length, 1, "the workspace route must be in the census");
  assert.equal(workspace[0].method, "GET");
  assert.equal(workspace[0].implementations[0].requiresOperator, true);

  // AND IT IS STILL UNCONSUMED, which is the honest half. `auth.server.ts` keeps
  // its Prisma query because there is no process to call. When core-api is
  // deployed and this route is wired, this assertion is the one that fails.
  assert.match(
    read("apps/webapp/app/services/auth.server.ts"),
    /database\.environment\.findFirst/u,
    "auth.server.ts no longer runs the slug query — if it now calls the workspace " +
      "route instead, the keystone is CONSUMED and this case should be replaced " +
      "by evidence that the webapp boots without DATABASE_URL",
  );
});
