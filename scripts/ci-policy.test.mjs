import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const expectedCandidates = [
  {
    name: "agent",
    image: "platos-agent",
    dockerfile: "apps/agent/Dockerfile",
    env_name: "AGENT",
  },
  {
    name: "webapp",
    image: "platos-webapp",
    dockerfile: "apps/webapp/Dockerfile.platos",
    env_name: "WEBAPP",
  },
  {
    name: "migrations",
    image: "platos-migrations",
    dockerfile: "internal-packages/tenancy-database/Dockerfile.migrations",
    env_name: "MIGRATIONS",
  },
];
const expectedInstallInstructions = new Map([
  [
    "apps/agent/Dockerfile",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
    ],
  ],
  [
    "apps/webapp/Dockerfile.platos",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --prod --filter webapp... --frozen-lockfile",
    ],
  ],
  [
    "internal-packages/tenancy-database/Dockerfile.migrations",
    ["RUN pnpm install --frozen-lockfile --prod"],
  ],
]);
const expectedPnpmRunInstructions = new Map([
  [
    "apps/agent/Dockerfile",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN pnpm run build:platos:agent",
      "RUN pnpm --filter platos-agent deploy --prod --legacy /deploy",
    ],
  ],
  [
    "apps/webapp/Dockerfile.platos",
    [
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile",
      "RUN cd /platos/internal-packages/tenancy-database && pnpx prisma@6.14.0 generate --schema prisma/schema.prisma",
      "RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --prod --filter webapp... --frozen-lockfile",
      "RUN --mount=type=secret,id=sentry_auth_token SENTRY_AUTH_TOKEN=$(cat /run/secrets/sentry_auth_token 2>/dev/null || true) pnpm run build:platos:webapp",
    ],
  ],
  [
    "internal-packages/tenancy-database/Dockerfile.migrations",
    ["RUN pnpm install --frozen-lockfile --prod"],
  ],
]);
// DELTA — WIN-284 moves ci from 3 to 4, and WIN-258 from 4 to 5. The count is
// one per JOB, so it IS each workflow's job count, and a new job that forgot to
// pin its Node version cannot pass.
//
// The fourth setup-node belongs to `differential-state-conservation`, which
// twin-runs the harness against two isolated PostgreSQL databases; the fifth to
// `postgres-tenancy-repository`, which runs the PostgreSQL TenancyRepository
// against a real container. Both need a Docker daemon that the typecheck job's
// service containers cannot provide, which is why each is its own job.
//
// The count is pinned rather than derived so that adding a job stays a reviewed
// decision: a silently appearing runner is how unreviewed steps enter a
// pipeline.
const expectedSetupNodeCounts = new Map([
  ["ci", 5],
  ["buildImages", 1],
]);
const relocatedCommands = [
  "pnpm --filter platos-agent exec vitest run src/auth/rate-limit.guard.test.ts",
  "pnpm --filter platos-agent exec vitest run src/memory/memory-profile-startup-verifier.service.test.ts",
  "pnpm --filter platos-agent exec vitest run src/startup-failure.test.ts",
  "pnpm test:persisted-state:performance-contract",
  "pnpm test:non-browser-completion:contract",
  "pnpm test:browser-evidence:contract",
  "pnpm test:route-parity:completion:evidence",
];
const v1ReleaseGateCommands = [
  "pnpm test:win253-clickhouse-split",
  "pnpm audit:win253-clickhouse-split",
  "pnpm test:win253-vendored-build",
  "pnpm audit:win253-vendored-build",
  "node scripts/arch/gen-v1-skeleton.mjs --check",
  "pnpm test:v1-foundation",
  "pnpm test:install-git-hooks",
  "pnpm audit:v1-project-graph",
  "pnpm test:v1-project-graph",
  "pnpm audit:max-file-lines",
  "pnpm test:max-file-lines",
  // WIN-256: the two gates ADR M0.3 specifies that M1 did not build.
  // §5.3 kernel-content keeps packages/kernel from becoming a junk drawer while
  // it hosts DurableRuntime/SafetyEventSink/ErasureTarget; §5.2 sole-writer makes
  // the canonical-row ownership map non-regressable.
  "pnpm audit:kernel-content",
  "pnpm test:kernel-content",
  "pnpm audit:sole-writer",
  "pnpm test:sole-writer",
  // WIN-297: rule (j) narrowed from a package to the one file, plus the
  // real-tree negative controls for rules (j) and (a). See the note on the same
  // pair in expectedV1EvidenceCommands below.
  "pnpm audit:composition-root",
  "pnpm test:composition-root",
  // WIN-260 (M2.5): "feature code does not read process.env", made countable.
  // See the note on the same pair in expectedV1EvidenceCommands below.
  "pnpm audit:env-access",
  "pnpm test:env-access",
  // WIN-260 (M2.5, outbox/clock/retry): the transaction-outcome refusal, made
  // FALSIFIABLE. See the note on the same pair in expectedV1EvidenceCommands
  // below.
  "pnpm audit:transaction-outcome",
  "pnpm test:transaction-outcome",
  "pnpm test:webapp-image-inventory",
  "pnpm test:webapp-inventory-contract",
  "pnpm test:advisory",
  "pnpm audit:advisory:check",
  // WIN-299 (M2.6). audit:advisory:check now fails on any un-dispositioned
  // CRITICAL/HIGH; this proves that gate can actually fail, on the same terms
  // audit:sbom:nonvacuity already proves it for the licence gate.
  "pnpm audit:advisory:nonvacuity",
  "pnpm build:v1",
  // WIN-256: the V1 packages' own suites, ordered after build:v1 because a
  // context test resolves its peers through their built dist/ entrypoints.
  // WIN-297 widened the filter to apps/core-api and apps/mcp-stdio, whose
  // executable start/stop evidence spawns the BUILT dist/main.js — which is why
  // this must stay after build:v1 and why those two projects' turbo `test` task
  // depends on their own `build`, not only on `^build`.
  "pnpm test:v1-packages",
];
const repositoryGovernanceCommands = [
  "pnpm audit:root-manifest",
  "pnpm test:root-manifest",
  "pnpm exec lefthook validate",
  "pnpm audit:hook-policy",
  "pnpm test:hook-policy",
];
const workspaceReachabilityCommands = [
  "pnpm test:workspace-reachability",
  "pnpm audit:workspace-reachability",
];
const reviewedSourceFetchStepName = "Fetch exact WIN-253 vendored-build reviewed source";
const reviewedSourceTag =
  "refs/tags/provenance/win253-vendored-build/e720b7618e58b27d3ff4f9aff5a5ca9ac6670130";
const reviewedSourceCommit = "e720b7618e58b27d3ff4f9aff5a5ca9ac6670130";
const reviewedSourceRef =
  "refs/platos-ci/provenance/win253-vendored-build/e720b7618e58b27d3ff4f9aff5a5ca9ac6670130";
const reviewedSourceFetchScript = [
  "set -euo pipefail",
  "git fetch --no-tags --force origin \\",
  '  "${REVIEWED_SOURCE_TAG}:${REVIEWED_SOURCE_REF}"',
  'resolved_commit="$(git rev-parse --verify "${REVIEWED_SOURCE_REF}^{commit}")"',
  'test "$resolved_commit" = "$REVIEWED_SOURCE_COMMIT"',
].join("\n") + "\n";
const win254EvidenceStepName = "WIN-254 docs, design, protection, and lifecycle evidence";
const win254EvidenceCommands = [
  "pnpm test:docs-link-integrity",
  "pnpm test:design-provenance",
  "pnpm test:protected-paths",
  "pnpm test:evidence-lifecycle",
  "node --test scripts/verify-win254.test.mjs",
  "pnpm verify:win254",
];
const expectedWin254Scripts = new Map([
  ["audit:docs-link-integrity", "node scripts/docs-link-integrity.mjs"],
  ["test:docs-link-integrity", "node --test scripts/docs-link-integrity.test.mjs"],
  ["audit:design-provenance", "node scripts/design-provenance.mjs check"],
  ["test:design-provenance", "node --test scripts/design-provenance.test.mjs"],
  ["generate:protected-paths", "node scripts/protected-paths.mjs write"],
  ["audit:protected-paths", "node scripts/protected-paths.mjs check"],
  ["test:protected-paths", "node --test scripts/protected-paths.test.mjs"],
  ["generate:evidence-lifecycle", "node scripts/evidence-lifecycle.mjs write"],
  ["audit:evidence-lifecycle", "node scripts/evidence-lifecycle.mjs check"],
  ["test:evidence-lifecycle", "node --test scripts/evidence-lifecycle.test.mjs"],
  ["audit:docs-build", "pnpm --filter docs validate && pnpm --filter docs broken-links"],
  ["audit:v1-ledger", "node scripts/v1-ledger.mjs --check"],
  ["audit:contract-map", "node scripts/arch/contract-map.mjs --check"],
  ["test:win254", "node --test scripts/docs-link-integrity.test.mjs scripts/design-provenance.test.mjs scripts/protected-paths.test.mjs scripts/evidence-lifecycle.test.mjs scripts/verify-win254.test.mjs"],
  ["generate:win254", "node scripts/verify-win254.mjs --regenerate"],
  ["verify:win254", "node scripts/verify-win254.mjs"],
]);
const workloadPackageTestCommand = "pnpm test:workload-identity-package";
const agentRuntimeSmokeTestCommand = "pnpm test:agent-runtime-smoke";
const licenseDeterminismTestCommand = "pnpm test:licenses";
const compiledAgentDependenciesStepName = "Generate and build compiled Agent dependencies";
const compiledAgentDependenciesCommand =
  "pnpm --filter @platos/tenancy-database build && pnpm --filter @internal/workload-identity build";
const installDependenciesStepName = "Install dependencies";
const focusedDirectAgentTestStepName =
  "Reproduce clean hosted-CI focused Agent Vitest consumers";
const focusedDirectAgentTestCommand =
  "pnpm --filter platos-agent exec vitest run chat-session.task.test.ts internal-chat-turn-options.test.ts";
const compiledWebappDependenciesStepName =
  "Generate and build compiled Webapp test dependencies";
const persistedStateInstallDependenciesStepName = "Install lockfile-backed test dependencies";
const persistedStateInstallDependenciesCommand =
  "pnpm install --frozen-lockfile --ignore-scripts";
const webappMemoryPolicyStepName = "Webapp memory-policy tests";
const webappMemoryPolicyCommand =
  "pnpm --filter webapp exec vitest run test/memoryPolicy.test.ts";
const persistedStateIntegrationStepName =
  "Exercise live Remix adapters, generated links, and Agent controllers";
const persistedStateIntegrationScriptName = "test:persisted-state:integration";
const persistedStateIntegrationTarget =
  "pnpm --filter webapp exec vitest run test/persistedStateGate.integration.test.ts";
const persistedStateIntegrationRun = [
  "set -euo pipefail",
  "pnpm test:persisted-state:integration \\",
  "  2>&1 | tee artifacts/win235/integration.log",
  "",
].join("\n");
const workloadPackageTestTarget = "node --test scripts/workload-identity-package.test.mjs";
const agentRuntimeSmokeTestTarget = "node --test tests/persisted-state-gate/agent-runtime-health.test.mjs";
const licenseDeterminismTestTarget = "node --test scripts/audit-licenses.test.mjs";
const agentBuildScriptTarget =
  "pnpm --filter @platos/tenancy-database build && pnpm --filter @internal/docs build && pnpm --filter @internal/workload-identity build && pnpm --filter platos-agent build:strict && pnpm --filter platos-agent audit:production-dependencies";
const agentRuntimeSmokeInvocation =
  "tests/persisted-state-gate/smoke-agent-runtime-image.sh \\\n  2>&1 | tee artifacts/win235/agent-runtime-smoke.log";
const expectedV1EvidenceCommands = [
  "pnpm test:ci-policy",
  ...repositoryGovernanceCommands,
  "node --test scripts/vocabulary-boundary.nul.test.mjs",
  "node --test scripts/v1-ledger.test.mjs",
  "node scripts/v1-ledger.mjs --check",
  "pnpm test:win253-clickhouse-split",
  "pnpm audit:win253-clickhouse-split",
  "pnpm test:win253-vendored-build",
  "pnpm audit:win253-vendored-build",
  "pnpm audit:capability-matrix",
  // WIN-256: the owner-column controls for the matrix the line above audits.
  // Invoked directly rather than through a package.json script, because root
  // package.json is a webapp image build input and adding a line there moves
  // the SBOM receipt buildInputsSha256.
  "node --test scripts/capability-matrix.test.mjs",
  "node scripts/rest-census-independent.mjs --check",
  "node --test scripts/rest-census-independent.test.mjs",
  "node scripts/webapp-bff-matrix.mjs --check",
  "node --test scripts/webapp-bff-matrix.test.mjs",
  "node scripts/operator-operations.mjs --check",
  "node --test scripts/license-distribution.test.mjs",
  "node scripts/arch/gen-v1-skeleton.mjs --check",
  "pnpm test:v1-foundation",
  "pnpm test:install-git-hooks",
  "pnpm audit:v1-project-graph",
  "pnpm test:v1-project-graph",
  "pnpm audit:arch-boundaries",
  "pnpm test:arch-boundaries",
  "pnpm audit:max-file-lines",
  "pnpm test:max-file-lines",
  // WIN-256: the two gates ADR M0.3 specifies that M1 did not build.
  // §5.3 kernel-content keeps packages/kernel from becoming a junk drawer while
  // it hosts DurableRuntime/SafetyEventSink/ErasureTarget; §5.2 sole-writer makes
  // the canonical-row ownership map non-regressable.
  "pnpm audit:kernel-content",
  "pnpm test:kernel-content",
  // WIN-260 (M2.5). §5.3's clock discipline, which four context headers state in
  // PROSE and nothing checked: `Date.now()`, a no-argument `new Date()`,
  // `performance.now()`, `Math.random()` and `setTimeout` in a context's domain
  // or application. `boundary-rules.mjs` could not carry it — it is an
  // import-graph checker and `Date` is a global, so there is no import to ban.
  // Invoked directly rather than through a package.json script, for the reason
  // given on `capability-matrix.test.mjs` above: root package.json is a webapp
  // image build input and a line there moves the SBOM receipt buildInputsSha256.
  "node scripts/arch/ambient-time.mjs",
  "node --test scripts/arch/ambient-time.test.mjs",
  "pnpm audit:sole-writer",
  "pnpm test:sole-writer",
  // WIN-297: rule (j) `adapters-only-from-core` names a PACKAGE; ADR M0.3 §4
  // says "THE composition root: the one place adapters are bound to context
  // ports". Twelve adapter imports scattered across six transport directories
  // satisfy the rule and not the sentence. This gate narrows rule (j) to one
  // FILE, cross-checks the binding table against the ADR §4/§13 ownership map,
  // and pins the single declared run-time-resolved import. Its negative controls
  // — including the real-tree rule (j) and rule (a) controls this issue's
  // acceptance requires — are in the test beside it.
  "pnpm audit:composition-root",
  "pnpm test:composition-root",
  // WIN-260 (M2.5). The milestone's acceptance opens with "feature code does not
  // read process.env". That was TRUE at f88c8364 and pinned nowhere: nothing in
  // the repository said where an environment read may live, so the property was
  // one line away from being false in a package nobody would think to check --
  // the same position the ORM was in before ADR M0.3 s15 invented
  // `tenancy-prisma-only`. This gate names the declared readers, pins every
  // test-support read to an exact count in both directions, and fails closed on
  // a computed key it cannot attribute. Its negative controls, one per violation
  // code, are in the test beside it.
  "pnpm audit:env-access",
  "pnpm test:env-access",
  // WIN-260 (M2.5, outbox/clock/retry). `UnitOfWork.run` REFUSES a callback
  // whose answer is a `Result`, because such a callback RESOLVES and a resolved
  // callback COMMITS -- the defect `cost-monitoring` shipped. `tsc` enforces
  // that on every build, and NOTHING WOULD GO RED IF IT WERE LOST: dropping
  // `NotResult<Value>` back to `Value` makes the tree compile again and leaves
  // every suite green. This gate compiles eight probes against the committed
  // port and asserts what the compiler answered, so the type guard has a named
  // case that turns red. Its second rule refuses a cast of the receiver of
  // `.run(`, which is how a call site would walk around a refusal that still
  // holds; two rules, two codes, because they are two different failures.
  "pnpm audit:transaction-outcome",
  "pnpm test:transaction-outcome",
  "pnpm test:webapp-image-inventory",
  "pnpm test:webapp-inventory-contract",
  "pnpm test:advisory",
  "pnpm audit:advisory:check",
  "pnpm audit:advisory:nonvacuity",
  "pnpm build:v1",
  // WIN-256: the V1 packages' own suites. Runs AFTER build:v1 because a context
  // test resolves its peers through their built dist/ entrypoints — and, since
  // WIN-297, because the two apps' executable evidence spawns dist/main.js.
  "pnpm test:v1-packages",
  // WIN-256 owner decision 9 (2026-09-02): the per-package test CASE census.
  // `test:v1-packages` above prints a case count and passes at any value, and
  // docs/v1-ledger-rules.json pins only test FILE counts, so deleting it()
  // blocks inside a retained file was invisible to every gate in this list.
  // Runs immediately after the suites it pins, so the two numbers are read from
  // the same tree in the same step.
  "pnpm audit:test-case-census",
  "pnpm test:test-case-census",
  "node scripts/arch/contract-map.mjs --check",
  "pnpm audit:sbom:check",
  "pnpm audit:sbom:nonvacuity",
  "pnpm test:sbom",
  // WIN-284 (+2). The differential capability coverage matrix. `test:` proves
  // the matrix cannot be inflated — a claim naming a capability no census
  // contains is a hard error, and dropping a cell moves the digest — and
  // `audit:` proves the committed matrix is still reconciled to the four M0
  // censuses. Both belong in the V1 evidence step because the matrix is an
  // evidence artifact of the same class as the censuses it reads.
  "pnpm test:differential-coverage",
  "pnpm audit:differential-coverage",
];
// WIN-284. The two coverage commands inside the V1 evidence step, listed
// separately so each gets its own removal and concealment control below. A gate
// added to the evidence list without a control proving it can be removed is a
// gate nobody has watched go missing.
const differentialCoverageCommands = ["pnpm test:differential-coverage", "pnpm audit:differential-coverage"];

// WIN-284. The negative-control catalogue runs as its own step so it is legible
// in the log as the acceptance evidence for the issue rather than buried in a
// test summary. It is pinned here for the same reason the V1 evidence step is:
// without a rule, the run that proves the harness detects seeded divergence
// could be deleted from CI and every other check would stay green.
const expectedDifferentialHarnessStepName = "WIN-284 differential harness and its negative controls";
const expectedDifferentialHarnessCommands = [
  "pnpm test:differential-harness",
  "pnpm test:differential-harness:controls",
];
const expectedDifferentialConservationJob = "differential-state-conservation";
const expectedDifferentialConservationCommand = "pnpm test:differential-harness:store";

const expectedRepositoryGovernanceScripts = new Map([
  ["generate:root-manifest", "node scripts/root-entry-manifest.mjs --write"],
  ["audit:root-manifest", "node scripts/root-entry-manifest.mjs --check"],
  ["test:root-manifest", "node --test scripts/root-entry-manifest.test.mjs"],
  ["audit:hook-policy", "node scripts/hook-policy.mjs"],
  ["test:hook-policy", "node --test scripts/hook-policy.test.mjs"],
]);
const expectedWorkspaceReachabilityScripts = new Map([
  ["generate:workspace-reachability", "node scripts/workspace-reachability.mjs generate"],
  ["audit:workspace-reachability", "node scripts/workspace-reachability.mjs check"],
  ["test:workspace-reachability", "node --test scripts/workspace-reachability.test.mjs"],
]);
const win290Command = "pnpm test:win-290";
const win290ScriptTarget =
  "pnpm --filter platos-agent exec vitest run src/shared/clickhouse-deadline.test.ts src/monitoring/spans.clickhouse-deadline.test.ts src/monitoring/span-dlq.test.ts src/monitoring/trace-request-abort.test.ts --no-file-parallelism";
const win290RedisCommand = "pnpm test:win-290:redis";
const win290RedisScriptTarget =
  "pnpm --filter platos-agent exec vitest run src/monitoring/spans.dlq.redis.test.ts";
const win290RedisStepName = "WIN-290 real Redis DLQ lifecycle suite";
const win290RedisUrl = "redis://127.0.0.1:6379";
const expectedWin290RedisService = {
  image: "redis:7",
  ports: ["6379:6379"],
  options:
    '--health-cmd "redis-cli ping" --health-interval 2s --health-timeout 5s --health-retries 30',
};

const expectedV1PackageScripts = new Map([
  ["build:v1", "tsc -b tsconfig.json"],
  ["clean:v1", "node scripts/arch/clean-v1.mjs"],
  ["test:v1-foundation", "pnpm test:gen-v1-skeleton && pnpm test:clean-v1"],
  ["test:gen-v1-skeleton", "node --test scripts/arch/gen-v1-skeleton.test.mjs"],
  ["test:clean-v1", "node --test scripts/arch/clean-v1.test.mjs"],
  ["test:install-git-hooks", "node --test scripts/install-git-hooks.test.mjs"],
  ["test:win253-clickhouse-split", "node --test scripts/clickhouse-split-audit.test.mjs"],
  ["audit:win253-clickhouse-split", "node scripts/clickhouse-split-audit.mjs --check"],
  ["test:win253-vendored-build", "node --test scripts/vendored-build-audit.test.mjs"],
  ["audit:win253-vendored-build", "node scripts/vendored-build-audit.mjs"],
  ["audit:v1-project-graph", "node scripts/arch/v1-project-graph.mjs"],
  ["test:v1-project-graph", "node --test scripts/arch/v1-project-graph.test.mjs"],
  ["audit:max-file-lines", "node scripts/arch/max-file-lines.mjs"],
  ["test:max-file-lines", "node --test scripts/arch/max-file-lines.test.mjs"],
  ["test:webapp-image-inventory", "node --test scripts/image-package-inventory.test.mjs scripts/verify-webapp-image-inventory.test.mjs"],
  ["test:webapp-inventory-contract", "node --test scripts/webapp-inventory-contract.test.mjs"],
  // WIN-299 (M2.6): test:advisory now covers the disposition gate's unit suite
  // alongside the receipt suite, the same two-file shape test:webapp-image-inventory
  // already uses above.
  ["test:advisory", "node --test scripts/audit-advisory.test.mjs scripts/advisory-dispositions.test.mjs"],
  ["audit:advisory:check", "node scripts/audit-advisory.mjs --check"],
  ["audit:advisory:nonvacuity", "node scripts/verify-advisory-nonvacuity.mjs"],
]);
const webappInventoryPackageScript = "bash scripts/audit-webapp-image-inventory.sh";
const webappInventoryCommand = "pnpm audit:webapp-image-inventory";
const webappInventoryStepName = "Verify distinct production-deps and exact final webapp candidate inventories";
const webappInventoryUploadStepName = "Retain verified webapp candidate inventory provenance";
const webappFinalImageAssignment =
  'final_image="win253.local/platos-webapp:verified-$candidate_digest_hex"';
const expectedWebappInventoryVerifierCommands = [
  "node scripts/verify-webapp-image-inventory.mjs --image $production_image --stage production-deps --evidence $evidence_dir/production-deps.json --candidate-archive $WEBAPP_CANDIDATE_ARCHIVE --candidate-manifest-digest $candidate_digest --candidate-archive-sha256 $WIN235_WEBAPP_ARCHIVE_SHA256",
  "node scripts/verify-webapp-image-inventory.mjs --image $final_image --stage final --evidence $evidence_dir/final.json --candidate-archive $WEBAPP_CANDIDATE_ARCHIVE --candidate-manifest-digest $candidate_digest --candidate-archive-sha256 $WIN235_WEBAPP_ARCHIVE_SHA256",
];
const webappPublicationValidatorCommand =
  "node scripts/verify-webapp-publication-provenance.mjs --candidate-identities artifacts/gate/candidate-images.json --inventory-root artifacts/webapp-inventory --candidate-archive artifacts/candidates/webapp.oci.tar";
const requiredWebappPublicationValidatorControls = [
  [
    "source-run candidate identities",
    "JSON.stringify(tested),\n  JSON.stringify(expectedIdentities),",
    "JSON.stringify(expectedIdentities),\n  JSON.stringify(expectedIdentities),",
  ],
  [
    "evidence schema",
    'requireEqual(evidence.$schema, WEBAPP_INVENTORY_EVIDENCE_SCHEMA',
    'requireEqual(WEBAPP_INVENTORY_EVIDENCE_SCHEMA, WEBAPP_INVENTORY_EVIDENCE_SCHEMA',
  ],
  ["evidence stage", "requireEqual(evidence.stage, stage", "requireEqual(stage, stage"],
  ["source run ID", "requireEqual(evidence.sourceRunId, sourceRunId", "requireEqual(sourceRunId, sourceRunId"],
  ["source run attempt", "requireEqual(evidence.sourceRunAttempt, sourceRunAttempt", "requireEqual(sourceRunAttempt, sourceRunAttempt"],
  [
    "independent archive identity derivation",
    "archiveIdentity = deriveOciArchiveIdentity({",
    "archiveIdentity = deriveOciArchiveIdentityNoOp({",
  ],
  [
    "candidate manifest digest",
    "evidence.candidateManifestDigest,\n    archiveIdentity.manifestDigest,",
    "archiveIdentity.manifestDigest,\n    archiveIdentity.manifestDigest,",
  ],
  [
    "candidate config digest",
    "evidence.candidateConfigDigest,\n    archiveIdentity.configDigest,",
    "archiveIdentity.configDigest,\n    archiveIdentity.configDigest,",
  ],
  [
    "candidate archive checksum",
    "evidence.candidateArchiveSha256,\n    archiveIdentity.archiveSha256,",
    "archiveIdentity.archiveSha256,\n    archiveIdentity.archiveSha256,",
  ],
  ["target platform", 'requireEqual(evidence.platform, WEBAPP_TARGET_PLATFORM', 'requireEqual(WEBAPP_TARGET_PLATFORM, WEBAPP_TARGET_PLATFORM'],
  ["Git revision", "requireEqual(evidence.gitHead, candidateSha", "requireEqual(candidateSha, candidateSha"],
  ["image revision label", "requireEqual(evidence.imageRevisionLabel, candidateSha", "requireEqual(candidateSha, candidateSha"],
  ["image build-input label", "requireEqual(evidence.imageBuildInputsLabel, currentBuildInputsSha256", "requireEqual(currentBuildInputsSha256, currentBuildInputsSha256"],
  ["evidence build-input hash", "requireEqual(evidence.buildInputsSha256, currentBuildInputsSha256", "requireEqual(currentBuildInputsSha256, currentBuildInputsSha256"],
  ["inventory byte equality", "requireEqual(evidence.inventoryByteMatch, true", "requireEqual(true, true"],
  [
    "inventory hash equality",
    "evidence.generatedInventorySha256,\n    evidence.committedInventorySha256,",
    "evidence.generatedInventorySha256,\n    evidence.generatedInventorySha256,",
  ],
  ["distinct production-deps and final images", "assertDistinctStageImageIds(production, final)", "assertDistinctStageImageIds(final, final)"],
  [
    "final archive image identity",
    "finalImageMatchesArchiveIdentity(evidence, archiveIdentity)",
    "finalImageMatchesArchiveIdentity(archiveIdentity, archiveIdentity)",
  ],
];
const requiredPerformanceArchiveIdentityControls = [
  "archiveIdentity = deriveOciArchiveIdentity({",
  "expectedManifestDigest: manifestDigest,",
  "evidence.candidateConfigDigest,\n    archiveIdentity.configDigest,",
  "evidence.candidateArchiveSha256,\n    archiveIdentity.archiveSha256,",
  "finalImageMatchesArchiveIdentity(evidence, archiveIdentity)",
  "webappCandidateArchivePath(root)",
];
const shippingDockerfiles = [...expectedInstallInstructions.keys()];
const prepareTarget = "scripts/install-git-hooks.mjs";
const webappPrepareCopy = `COPY --from=pruner --chown=node:node /platos/${prepareTarget} ./${prepareTarget}`;
const shellInterpreters = new Set(["bash", "sh", "dash", "zsh", "ksh", "ash"]);
const corepackManagementCommands = new Set([
  "cache",
  "disable",
  "enable",
  "hydrate",
  "install",
  "pack",
  "prepare",
  "up",
  "use",
]);

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function fixtures() {
  return {
    nvmrc: source(".nvmrc"),
    packageJson: source("package.json"),
    ci: source(".github/workflows/ci.yml"),
    buildImages: source(".github/workflows/build-images.yml"),
    publishImages: source(".github/workflows/publish-images.yml"),
    webappInventoryAudit: source("scripts/audit-webapp-image-inventory.sh"),
    webappInventoryVerifier: source("scripts/verify-webapp-image-inventory.mjs"),
    webappInventoryContract: source("scripts/lib/webapp-inventory-contract.mjs"),
    webappPublicationValidator: source("scripts/verify-webapp-publication-provenance.mjs"),
    performanceVerifier: source("tests/persisted-state-gate/verify-performance-artifacts.mjs"),
    performanceRunner: source("tests/persisted-state-gate/run-performance.mjs"),
    dockerfiles: Object.fromEntries(shippingDockerfiles.map((file) => [file, source(file)])),
  };
}

function parseWorkflow(workflow, label, violations) {
  let document;
  try {
    document = parseDocument(workflow, { prettyErrors: false, uniqueKeys: true });
  } catch {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  if (document.errors.length > 0) {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  let parsed;
  try {
    parsed = document.toJS();
  } catch {
    violations.push(`${label} must remain valid, uniquely keyed YAML`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    violations.push(`${label} must contain a workflow mapping`);
    return {};
  }
  return parsed;
}

function workflowJobs(workflow) {
  const jobs = workflow?.jobs;
  return jobs !== null && typeof jobs === "object" && !Array.isArray(jobs)
    ? new Map(Object.entries(jobs))
    : new Map();
}

function workflowSteps(job) {
  return Array.isArray(job?.steps)
    ? job.steps.filter((step) => step !== null && typeof step === "object")
    : [];
}

function executableRunValues(job) {
  return workflowSteps(job)
    .map((step) => step.run)
    .filter((run) => typeof run === "string");
}

function allWorkflowSteps(workflow) {
  return [...workflowJobs(workflow).values()].flatMap(workflowSteps);
}

function permissionDeclarations(workflow) {
  return [
    workflow?.permissions,
    ...[...workflowJobs(workflow).values()].map((job) => job?.permissions),
  ].filter((permissions) => permissions !== undefined && permissions !== null);
}

function eventBranches(workflow, eventName) {
  const branches = workflow?.on?.[eventName]?.branches;
  return Array.isArray(branches) ? branches : null;
}

function imageCandidates(buildCandidatesJob) {
  const candidates = buildCandidatesJob?.strategy?.matrix?.include;
  return Array.isArray(candidates) ? candidates : [];
}

function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (current.trim() !== "") segments.push(current.trim());
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flush();
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (command[index + 1] === "\n") {
        index += 1;
        current += " ";
      } else {
        escaped = true;
        current += character;
      }
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#" && (current === "" || /\s$/u.test(current))) {
      comment = true;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (
      character === "\n" ||
      character === ";" ||
      character === "|" ||
      pair === "&&" ||
      pair === "||"
    ) {
      flush();
      if (pair === "&&" || pair === "||") index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function shellWords(segment) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (current !== "") words.push(current);
    current = "";
  };
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "<" || character === ">") {
      flush();
      words.push(character);
    } else if (/\s/u.test(character)) {
      flush();
    } else {
      current += character;
    }
  }
  flush();
  return words;
}

function executableShellArgv(segment) {
  const words = shellWords(segment.replace(/^[({]+\s*/u, ""));
  let index = 0;
  while (index < words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index += 1;
    const wrapper = words[index];
    if (
      !new Set([
        "env",
        "sudo",
        "command",
        "builtin",
        "exec",
        "time",
        "nice",
        "nohup",
        "then",
        "if",
        "while",
        "until",
        "!",
      ]).has(wrapper)
    )
      break;
    index += 1;
    while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? ""))
      index += 1;
  }
  const argv = words.slice(index);
  if (argv.length > 0) argv[0] = argv[0].replace(/^.*\//u, "");
  if (argv.length > 0) argv[argv.length - 1] = argv[argv.length - 1].replace(/[)}]+$/u, "");
  return argv;
}

function executableRunCommands(job) {
  return executableRunValues(job).flatMap(shellSegments);
}

const forbiddenEvidenceKeywords = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "function",
  "eval",
  "source",
  ".",
  "bash",
  "sh",
  "dash",
  "zsh",
  "ksh",
  "ash",
]);

function reviewedTopLevelCommands(run) {
  if (typeof run !== "string") return { commands: [], valid: false };
  const commands = [];
  for (const rawLine of run.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const words = line.split(/\s+/u);
    if (
      !/^[A-Za-z0-9_./:@*+=,-]+(?:\s+[A-Za-z0-9_./:@*+=,-]+)*$/u.test(line) ||
      words.some((word) => forbiddenEvidenceKeywords.has(word.toLowerCase())) ||
      ((words[0] === "node" || words[0] === "python" || words[0] === "python3") &&
        words.some((word) => ["-e", "-p", "-c"].includes(word)))
    )
      return { commands: [], valid: false };
    commands.push(line);
  }
  return { commands, valid: commands.length > 0 };
}

function dockerRunInstructions(dockerfile) {
  const lines = dockerfile.split("\n");
  const instructions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(/^\s*(RUN)(?:\s+(.*))?$/iu);
    if (!start) continue;
    const keyword = start[1];
    let instruction = start[2] ?? "";
    while (instruction.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      instruction = `${instruction.trimEnd().slice(0, -1)} ${lines[(index += 1)].trim()}`;
    }
    const heredoc = instruction.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u);
    if (heredoc) {
      const body = [];
      while (index + 1 < lines.length) {
        const line = lines[(index += 1)];
        body.push(line);
        if (line.trim() === heredoc[1]) break;
      }
      instruction = `${instruction}\n${body.join("\n")}`;
    }
    instructions.push(`${keyword} ${instruction.replace(/\s+/gu, " ").trim()}`.trim());
  }
  return instructions;
}

function pnpmExecutableToken(word) {
  const normalized = word
    .replace(/^[`$({[]+/u, "")
    .replace(/[,\]})]+$/u, "")
    .replace(/^.*\//u, "");
  return normalized === "pnpm" || normalized === "pnpx";
}

function dynamicCommandToken(word) {
  return /(?:\$|`)/u.test(word);
}

function corepackPnpmToken(word) {
  const normalized = word.replace(/^.*\//u, "").toLowerCase();
  return normalized === "pnpm" || normalized === "pnpx" || /^(?:pnpm|pnpx)@/u.test(normalized);
}

function jsonPnpmInvocation(argv) {
  if (
    !Array.isArray(argv) ||
    !argv.every((argument) => typeof argument === "string") ||
    argv.length === 0
  ) {
    return { ambiguous: true, pnpmIndex: null, argv: [] };
  }
  let command = [...argv];
  let index = 0;
  const executable = () => command[index]?.replace(/^.*\//u, "").toLowerCase();

  if (executable() === "env") {
    index += 1;
    while (index < command.length) {
      const argument = command[index];
      if (argument === "--") {
        index += 1;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
        index += 1;
        continue;
      }
      if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(argument)) {
        index += 1;
        continue;
      }
      if (/^--(?:unset|chdir)=/u.test(argument)) {
        index += 1;
        continue;
      }
      if (["-u", "--unset", "-C", "--chdir"].includes(argument)) {
        if (index + 1 >= command.length) return { ambiguous: true, pnpmIndex: null, argv: command };
        index += 2;
        continue;
      }
      const splitString =
        argument === "-S" || argument === "--split-string"
          ? command[index + 1]
          : argument.startsWith("--split-string=")
          ? argument.slice("--split-string=".length)
          : argument.startsWith("-S") && argument.length > 2
          ? argument.slice(2)
          : null;
      if (splitString !== null) {
        if (typeof splitString !== "string")
          return { ambiguous: true, pnpmIndex: null, argv: command };
        const splitArgv = shellWords(splitString);
        if (splitArgv.length === 0) return { ambiguous: true, pnpmIndex: null, argv: command };
        const consumed = argument === "-S" || argument === "--split-string" ? 2 : 1;
        command = [...splitArgv, ...command.slice(index + consumed)];
        index = 0;
        break;
      }
      if (argument.startsWith("-")) return { ambiguous: true, pnpmIndex: null, argv: command };
      break;
    }
    if (index >= command.length || dynamicCommandToken(command[index])) {
      return { ambiguous: true, pnpmIndex: null, argv: command };
    }
  }

  if (executable() === "corepack") {
    index += 1;
    const subcommand = command[index];
    if (subcommand === undefined || dynamicCommandToken(subcommand)) {
      return { ambiguous: true, pnpmIndex: null, argv: command };
    }
    if (corepackManagementCommands.has(subcommand.toLowerCase())) {
      return { ambiguous: false, pnpmIndex: null, argv: command };
    }
    if (corepackPnpmToken(subcommand)) {
      return { ambiguous: false, pnpmIndex: index, argv: command };
    }
    return { ambiguous: true, pnpmIndex: null, argv: command };
  }

  if (pnpmExecutableToken(command[index] ?? "")) {
    return { ambiguous: false, pnpmIndex: index, argv: command };
  }
  if (dynamicCommandToken(command[index] ?? "")) {
    return { ambiguous: true, pnpmIndex: null, argv: command };
  }
  return { ambiguous: false, pnpmIndex: null, argv: command };
}

function pnpmInstallInvocation({ ambiguous, pnpmIndex, argv }) {
  if (ambiguous) return true;
  if (pnpmIndex === null) return false;
  return argv
    .slice(pnpmIndex + 1)
    .some(
      (argument) => argument === "install" || argument === "i" || dynamicCommandToken(argument)
    );
}

function containsExecutablePnpmInstall(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      return pnpmInstallInvocation(jsonPnpmInvocation(JSON.parse(command)));
    } catch {
      return /pnpm|pnpx|\$|`/iu.test(command);
    }
  }
  if (/\b(?:pnpm|pnpx)\b[\s\S]*\b(?:install|i)\b/iu.test(command)) return true;
  return shellSegments(command).some((segment) => {
    const words = shellWords(segment);
    const pnpmIndex = words.findIndex(pnpmExecutableToken);
    if (pnpmIndex === -1) return false;
    return words
      .slice(pnpmIndex + 1)
      .some(
        (argument) => argument === "install" || argument === "i" || dynamicCommandToken(argument)
      );
  });
}

function dockerInstallInstructions(dockerfile) {
  return dockerRunInstructions(dockerfile).filter(containsExecutablePnpmInstall);
}

function containsExecutablePnpm(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      const invocation = jsonPnpmInvocation(JSON.parse(command));
      return invocation.ambiguous || invocation.pnpmIndex !== null;
    } catch {
      return /pnpm|pnpx|\$|`/iu.test(command);
    }
  }
  return shellSegments(command).some((segment) => shellWords(segment).some(pnpmExecutableToken));
}

function dockerPnpmRunInstructions(dockerfile) {
  return dockerRunInstructions(dockerfile).filter(containsExecutablePnpm);
}

function hasInterpreterCommandPayload(argv) {
  const interpreterIndex = argv.findIndex((word) =>
    shellInterpreters.has(word.replace(/^.*\//u, "").toLowerCase())
  );
  if (interpreterIndex === -1) return false;
  return argv
    .slice(interpreterIndex + 1)
    .some((argument) => argument === "--command" || /^-[a-z]*c[a-z]*$/iu.test(argument));
}

function containsDockerInterpreterPayload(instruction) {
  const command = instruction.replace(/^RUN\s+/iu, "");
  if (command.startsWith("[")) {
    try {
      const argv = JSON.parse(command);
      return (
        Array.isArray(argv) &&
        argv.every((argument) => typeof argument === "string") &&
        hasInterpreterCommandPayload(argv)
      );
    } catch {
      return true;
    }
  }
  return shellSegments(command).some((segment) =>
    hasInterpreterCommandPayload(shellWords(segment))
  );
}

function countExact(values, expected) {
  return values.filter((value) => value === expected).length;
}

function countSubstring(values, expected) {
  let count = 0;
  for (const value of values) {
    let cursor = 0;
    while (cursor <= value.length - expected.length) {
      const found = value.indexOf(expected, cursor);
      if (found === -1) break;
      count += 1;
      cursor = found + expected.length;
    }
  }
  return count;
}

function normalizedRunCommands(job) {
  return executableRunCommands(job).map((command) => executableShellArgv(command).join(" "));
}

function normalizedShellCommands(sourceText) {
  return shellSegments(sourceText)
    .map(executableShellArgv)
    .filter((argv) => argv.length > 0)
    .map((argv) => argv.join(" "));
}

function effectiveStepWorkingDirectory(step, job, workflow) {
  return (
    step?.["working-directory"] ??
    job?.defaults?.run?.["working-directory"] ??
    workflow?.defaults?.run?.["working-directory"]
  );
}

function pnpmFilterTargetsWebapp(argv, execIndex) {
  for (let index = 1; index < execIndex; index += 1) {
    const argument = argv[index];
    if (
      (argument === "--filter" || argument === "-F") &&
      argv[index + 1] === "webapp"
    ) {
      return true;
    }
    if (argument === "--filter=webapp" || argument === "-F=webapp") return true;
  }
  return false;
}

function directWebappVitestInvocations(step, job, workflow) {
  if (typeof step?.run !== "string") return [];
  const workingDirectory = effectiveStepWorkingDirectory(step, job, workflow);
  return shellSegments(step.run).flatMap((segment) => {
    const argv = executableShellArgv(segment);
    if (argv[0] !== "pnpm") return [];
    const integrationScriptIndex = argv.findIndex(
      (argument, index) =>
        argument === persistedStateIntegrationScriptName &&
        (index === 1 || (index === 2 && argv[1] === "run"))
    );
    if (integrationScriptIndex !== -1) {
      return [{ vitestArguments: argv.slice(integrationScriptIndex + 1) }];
    }
    const execIndex = argv.findIndex(
      (argument, index) =>
        argument === "exec" && argv[index + 1] === "vitest" && argv[index + 2] === "run"
    );
    if (execIndex === -1) return [];
    const scopedByFilter = pnpmFilterTargetsWebapp(argv, execIndex);
    const scopedByWorkingDirectory =
      workingDirectory === "apps/webapp" || workingDirectory === "./apps/webapp";
    return scopedByFilter || scopedByWorkingDirectory
      ? [{ vitestArguments: argv.slice(execIndex + 3) }]
      : [];
  });
}

function hasDirectConsumerSuppression(run) {
  if (typeof run !== "string") return true;
  return (
    /\|\|/u.test(run) ||
    /\b(?:exit|return)\s+0\b/u.test(run) ||
    /(?:^|[;\n(])\s*(?:true|:|false)\s*&&/u.test(run) ||
    /(?:^|[^A-Za-z0-9_])(?:if|then|elif|else|fi|case|esac|while|until)\b/u.test(run)
  );
}

function hasDirectConsumerSourceAlias(invocations) {
  return invocations.some(({ vitestArguments }) =>
    vitestArguments.some(
      (argument) =>
        argument === "--alias" ||
        argument.startsWith("--alias=") ||
        argument === "--config" ||
        argument.startsWith("--config=") ||
        argument === "-c" ||
        argument.startsWith("-c=") ||
        /@internal\/workload-identity=|internal-packages\/workload-identity\/src/u.test(
          argument
        )
    )
  );
}

function relocatedSelector(command) {
  const vitestMarker = " exec vitest run ";
  return command.includes(vitestMarker)
    ? command.slice(command.indexOf(vitestMarker) + vitestMarker.length)
    : command;
}

function policyViolations(input) {
  const violations = [];
  const workflows = new Map([
    ["ci", { label: "ci.yml", workflow: parseWorkflow(input.ci, "ci.yml", violations) }],
    [
      "buildImages",
      {
        label: "build-images.yml",
        workflow: parseWorkflow(input.buildImages, "build-images.yml", violations),
      },
    ],
  ]);

  for (const { label, workflow } of workflows.values()) {
    for (const eventName of ["push", "pull_request"]) {
      const branches = eventBranches(workflow, eventName);
      if (JSON.stringify(branches) !== JSON.stringify(["main", "v1"])) {
        violations.push(`${label} ${eventName} must select exactly main and v1`);
      }
    }
  }

  const buildWorkflow = workflows.get("buildImages").workflow;
  const buildJobs = workflowJobs(buildWorkflow);

  const publishWorkflow = parseWorkflow(input.publishImages, "publish-images.yml", violations);
  const publishJob = workflowJobs(publishWorkflow).get("publish-images");
  const publicationValidatorCommands = normalizedRunCommands(publishJob).filter((command) =>
    command.startsWith("node scripts/verify-webapp-publication-provenance.mjs ")
  );
  if (JSON.stringify(publicationValidatorCommands) !== JSON.stringify([webappPublicationValidatorCommand])) {
    violations.push("publish-images must execute the exact webapp publication provenance validator once");
  }
  const publishSteps = workflowSteps(publishJob);
  const publicationValidatorIndex = publishSteps.findIndex((step) =>
    typeof step.run === "string" && step.run.includes("verify-webapp-publication-provenance.mjs")
  );
  const publicationLoginIndex = publishSteps.findIndex((step) =>
    typeof step.uses === "string" && step.uses.startsWith("docker/login-action@")
  );
  if (publicationValidatorIndex === -1 || publicationLoginIndex === -1 || publicationValidatorIndex >= publicationLoginIndex) {
    violations.push("publish-images must validate webapp provenance before registry authentication");
  }
  if (requiredWebappPublicationValidatorControls.some(([, control]) =>
    !input.webappPublicationValidator.includes(control)
  )) {
    violations.push("webapp publication validator must enforce every bound provenance field");
  }
  if (
    requiredPerformanceArchiveIdentityControls.some(
      (control) => !input.performanceVerifier.includes(control)
    ) ||
    !input.performanceRunner.includes("webappCandidateArchivePath(artifactDirectory)")
  ) {
    violations.push(
      "performance runner and verifier must independently enforce archive-derived webapp identity"
    );
  }
  const requiredSharedArchiveIdentityControls = [
    "manifestSize !== descriptor.size",
    "manifestDigest !== descriptor.digest",
    "const configDigest = manifest?.config?.digest",
    "evidence?.imageId === archiveIdentity?.configDigest",
    "evidence?.imageDescriptorDigest === archiveIdentity?.manifestDigest",
  ];
  if (
    requiredSharedArchiveIdentityControls.some(
      (control) => !input.webappInventoryContract.includes(control)
    )
  ) {
    violations.push(
      "shared webapp archive contract must bind descriptor, manifest, config, and portable image identity"
    );
  }

  const buildCandidatesJob = buildJobs.get("build-candidates");
  const candidates = imageCandidates(buildCandidatesJob);
  if (candidates.length === 0) violations.push("build image matrix candidate selector is empty");
  if (JSON.stringify(candidates) !== JSON.stringify(expectedCandidates)) {
    violations.push("build image matrix candidates must be unique and exact");
  }
  for (const key of ["name", "image", "dockerfile", "env_name"]) {
    if (new Set(candidates.map((candidate) => candidate[key])).size !== candidates.length) {
      violations.push(`build image matrix ${key} values must be unique`);
    }
  }

  const buildActionSteps = workflowSteps(buildCandidatesJob).filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("docker/build-push-action@")
  );
  if (buildActionSteps.length !== 1)
    violations.push("build-candidates must have exactly one build-push action");
  const buildAction = buildActionSteps[0];
  if (buildAction?.with?.file !== "${{ matrix.dockerfile }}") {
    violations.push("build-push action file must correlate to matrix.dockerfile");
  }
  if (buildAction?.with?.platforms !== "linux/amd64") {
    violations.push("build-push action must produce only the linux/amd64 candidate");
  }
  const buildArgs = typeof buildAction?.with?.["build-args"] === "string"
    ? buildAction.with["build-args"].split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  if (JSON.stringify(buildArgs) !== JSON.stringify([
    "BUILD_GIT_SHA=${{ env.PLATOS_CANDIDATE_SHA }}",
    "WEBAPP_INVENTORY_BUILD_INPUTS_SHA256=${{ steps.webapp-inventory-inputs.outputs.sha256 }}",
  ])) {
    violations.push("build-push action must apply the exact revision and webapp inventory build-input digest");
  }
  const candidateLabels = typeof buildAction?.with?.labels === "string"
    ? buildAction.with.labels.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  if (!candidateLabels.includes("org.opencontainers.image.revision=${{ env.PLATOS_CANDIDATE_SHA }}") ||
      !candidateLabels.includes("dev.winsen.platos.webapp-inventory-inputs-sha256=${{ steps.webapp-inventory-inputs.outputs.sha256 }}")) {
    violations.push("build-push action must label the candidate with revision and inventory build-input digest");
  }
  const inventoryInputSteps = workflowSteps(buildCandidatesJob).filter((step) => step.id === "webapp-inventory-inputs");
  if (inventoryInputSteps.length !== 1 ||
      inventoryInputSteps[0].run !== 'echo "sha256=$(node scripts/verify-webapp-image-inventory.mjs --print-build-inputs-sha256)" >> "$GITHUB_OUTPUT"') {
    violations.push("build-candidates must compute the exact webapp inventory build-input digest once");
  }

  for (const [file, expectedInstructions] of expectedInstallInstructions) {
    const interpreterPayloads = dockerRunInstructions(input.dockerfiles[file] ?? "").filter(
      containsDockerInterpreterPayload
    );
    if (interpreterPayloads.length > 0) {
      violations.push(
        `${file} must not contain shell interpreter command payload RUN instruction(s)`
      );
    }
    const installs = dockerInstallInstructions(input.dockerfiles[file] ?? "");
    if (installs.length === 0) violations.push(`${file} executable pnpm install selector is empty`);
    if (JSON.stringify(installs) !== JSON.stringify(expectedInstructions)) {
      violations.push(`${file} must contain only its exact frozen pnpm install RUN instruction(s)`);
    }
    const pnpmRuns = dockerPnpmRunInstructions(input.dockerfiles[file] ?? "");
    if (JSON.stringify(pnpmRuns) !== JSON.stringify(expectedPnpmRunInstructions.get(file))) {
      violations.push(
        `${file} must contain only its exact executable pnpm/pnpx RUN instruction(s)`
      );
    }
    if (installs.some((instruction) => instruction.includes("--ignore-scripts"))) {
      violations.push(`${file} shipping installs must execute lifecycle scripts`);
    }
  }

  if (input.nvmrc.trim() !== "v22.14.0") violations.push(".nvmrc must pin exactly v22.14.0");
  for (const [key, expectedCount] of expectedSetupNodeCounts) {
    const { label, workflow } = workflows.get(key);
    const setupNodeSteps = allWorkflowSteps(workflow).filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
    );
    if (setupNodeSteps.length !== expectedCount) {
      violations.push(`${label} must contain exactly ${expectedCount} setup-node step(s)`);
    }
    for (const step of setupNodeSteps) {
      if (
        step.with?.["node-version-file"] !== ".nvmrc" ||
        Object.hasOwn(step.with ?? {}, "node-version")
      ) {
        violations.push(`${label} setup-node must derive its version from .nvmrc`);
      }
    }
  }

  const ciWorkflow = workflows.get("ci").workflow;
  const ciJobs = workflowJobs(ciWorkflow);
  const typecheckSteps = workflowSteps(ciJobs.get("typecheck"));
  const typecheckCheckoutSteps = typecheckSteps.filter(
    (step) =>
      typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")
  );
  if (
    typecheckCheckoutSteps.length !== 1 ||
    typecheckCheckoutSteps[0].with?.["fetch-depth"] !== 0
  ) {
    violations.push("typecheck checkout must retain fetch-depth 0");
  }
  const reviewedSourceFetchSteps = typecheckSteps.filter(
    (step) => step.name === reviewedSourceFetchStepName
  );
  if (reviewedSourceFetchSteps.length !== 1) {
    violations.push("CI must contain exactly one reviewed-source immutable tag fetch step");
  }
  const reviewedSourceFetchStep = reviewedSourceFetchSteps[0] ?? {};
  const checkoutIndex = typecheckSteps.indexOf(typecheckCheckoutSteps[0]);
  const reviewedSourceFetchIndex = typecheckSteps.indexOf(reviewedSourceFetchStep);
  if (checkoutIndex === -1 || reviewedSourceFetchIndex !== checkoutIndex + 1) {
    violations.push("reviewed-source immutable tag fetch must run immediately after typecheck checkout");
  }
  if (
    reviewedSourceFetchStep.if !== undefined ||
    reviewedSourceFetchStep["continue-on-error"] !== undefined ||
    reviewedSourceFetchStep.shell !== undefined
  ) {
    violations.push("reviewed-source immutable tag fetch must be unconditional and fail-fast");
  }
  if (
    JSON.stringify(reviewedSourceFetchStep.env) !==
      JSON.stringify({
        REVIEWED_SOURCE_TAG: reviewedSourceTag,
        REVIEWED_SOURCE_COMMIT: reviewedSourceCommit,
        REVIEWED_SOURCE_REF: reviewedSourceRef,
      }) ||
    reviewedSourceFetchStep.run !== reviewedSourceFetchScript
  ) {
    violations.push(
      "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check"
    );
  }
  const reachabilitySteps = typecheckSteps.filter(
    (step) => step.name === "WIN-253 workspace reachability evidence"
  );
  if (reachabilitySteps.length !== 1)
    violations.push("CI must contain exactly one WIN-253 workspace reachability evidence step");
  const reachabilityStep = reachabilitySteps[0] ?? {};
  if (
    reachabilityStep.if !== undefined ||
    reachabilityStep["continue-on-error"] !== undefined ||
    reachabilityStep.shell !== undefined
  ) {
    violations.push(
      "WIN-253 workspace reachability evidence step must be unconditional and fail-fast"
    );
  }
  const typecheckJob = ciJobs.get("typecheck") ?? {};
  if (typecheckJob.if !== undefined || typecheckJob["continue-on-error"] !== undefined) {
    violations.push("WIN-253 workspace reachability job must be unconditional and fail-fast");
  }
  if (
    ciWorkflow.defaults?.run?.shell !== undefined ||
    typecheckJob.defaults?.run?.shell !== undefined
  ) {
    violations.push(
      "WIN-253 workspace reachability step must not inherit workflow or job shell defaults"
    );
  }
  const reviewedReachability = reviewedTopLevelCommands(reachabilityStep.run);
  if (
    !reviewedReachability.valid ||
    JSON.stringify(reviewedReachability.commands) !== JSON.stringify(workspaceReachabilityCommands)
  ) {
    violations.push(
      "WIN-253 workspace reachability evidence script must contain only the exact reviewed command sequence"
    );
  }
  const win254Steps = typecheckSteps.filter((step) => step.name === win254EvidenceStepName);
  if (win254Steps.length !== 1)
    violations.push("CI must contain exactly one WIN-254 evidence step");
  const win254Step = win254Steps[0] ?? {};
  if (
    win254Step.if !== undefined ||
    win254Step["continue-on-error"] !== undefined ||
    win254Step.shell !== undefined
  ) {
    violations.push("WIN-254 evidence step must be unconditional and fail-fast");
  }
  if (
    ciWorkflow.defaults?.run?.shell !== undefined ||
    typecheckJob.defaults?.run?.shell !== undefined
  ) {
    violations.push("WIN-254 evidence step must not inherit workflow or job shell defaults");
  }
  const reviewedWin254 = reviewedTopLevelCommands(win254Step.run);
  if (
    !reviewedWin254.valid ||
    JSON.stringify(reviewedWin254.commands) !== JSON.stringify(win254EvidenceCommands)
  ) {
    violations.push("WIN-254 evidence script must contain only the exact reviewed command sequence");
  }
  const installDependenciesSteps = typecheckSteps.filter(
    (step) => step.name === installDependenciesStepName
  );
  const compiledAgentDependenciesSteps = typecheckSteps.filter(
    (step) => step.name === compiledAgentDependenciesStepName
  );
  const directAgentTestSteps = typecheckSteps.filter(
    (step) => step.name === focusedDirectAgentTestStepName
  );
  if (compiledAgentDependenciesSteps.length !== 1) {
    violations.push("CI must contain exactly one compiled Agent dependencies build step");
  }
  const compiledAgentDependenciesStep = compiledAgentDependenciesSteps[0] ?? {};
  if (
    compiledAgentDependenciesStep.run !== compiledAgentDependenciesCommand ||
    compiledAgentDependenciesStep.if !== undefined ||
    compiledAgentDependenciesStep["continue-on-error"] !== undefined ||
    compiledAgentDependenciesStep.shell !== undefined
  ) {
    violations.push(
      "compiled Agent dependencies step must fail-fast on the exact tenancy and workload-identity dist builds"
    );
  }
  const installDependenciesIndex = typecheckSteps.indexOf(installDependenciesSteps[0]);
  const compiledAgentDependenciesIndex = typecheckSteps.indexOf(compiledAgentDependenciesStep);
  const directAgentTestsIndex = typecheckSteps.indexOf(directAgentTestSteps[0]);
  const directAgentVitestIndices = typecheckSteps.flatMap((step, index) =>
    typeof step.run === "string" &&
    normalizedShellCommands(step.run).some((command) =>
      command.startsWith("pnpm --filter platos-agent exec vitest run ")
    )
      ? [index]
      : []
  );
  const directAgentVitestSteps = directAgentVitestIndices.map((index) => typecheckSteps[index]);
  if (
    directAgentVitestSteps.some(
      (step) =>
        step.if !== undefined ||
        step["continue-on-error"] !== undefined ||
        step.shell !== undefined
    )
  ) {
    violations.push("every direct Agent Vitest step must be unconditional and fail-fast");
  }
  const focusedDirectAgentTestStep = directAgentTestSteps[0] ?? {};
  if (
    directAgentTestSteps.length !== 1 ||
    focusedDirectAgentTestStep.run !== focusedDirectAgentTestCommand ||
    focusedDirectAgentTestStep.if !== undefined ||
    focusedDirectAgentTestStep["continue-on-error"] !== undefined ||
    focusedDirectAgentTestStep.shell !== undefined
  ) {
    violations.push(
      "focused direct Agent hosted-CI reproduction must be one dedicated exact fail-fast run step"
    );
  }
  if (
    installDependenciesSteps.length !== 1 ||
    directAgentTestSteps.length !== 1 ||
    installDependenciesIndex === -1 ||
    compiledAgentDependenciesIndex <= installDependenciesIndex ||
    directAgentTestsIndex === -1 ||
    compiledAgentDependenciesIndex >= directAgentTestsIndex ||
    directAgentVitestIndices.length === 0 ||
    directAgentVitestIndices.some((index) => index <= compiledAgentDependenciesIndex)
  ) {
    violations.push(
      "compiled Agent dependencies must build after install and before every direct Agent Vitest consumer"
    );
  }
  if (countExact(normalizedRunCommands(typecheckJob), focusedDirectAgentTestCommand) !== 1) {
    violations.push("CI must retain the exact focused direct Agent hosted-CI reproduction command");
  }
  const v1EvidenceSteps = workflowSteps(ciJobs.get("typecheck")).filter(
    (step) => step.name === "V1 M0 executable evidence gates"
  );
  if (v1EvidenceSteps.length !== 1)
    violations.push("CI must contain exactly one V1 executable evidence step");
  const v1EvidenceStep = v1EvidenceSteps[0] ?? {};
  if (
    v1EvidenceStep.if !== undefined ||
    v1EvidenceStep["continue-on-error"] !== undefined ||
    v1EvidenceStep.shell !== undefined
  ) {
    violations.push("V1 evidence step must be unconditional and fail-fast");
  }
  const reviewedEvidence = reviewedTopLevelCommands(v1EvidenceStep.run);
  if (
    !reviewedEvidence.valid ||
    JSON.stringify(reviewedEvidence.commands) !== JSON.stringify(expectedV1EvidenceCommands)
  ) {
    violations.push("V1 evidence script must contain only reviewed top-level simple commands");
  }
  // WIN-284 — the negative-control run must stay in CI, unconditional, exact.
  const harnessSteps = workflowSteps(ciJobs.get("typecheck")).filter(
    (step) => step.name === expectedDifferentialHarnessStepName
  );
  if (harnessSteps.length !== 1)
    violations.push("CI must contain exactly one WIN-284 differential harness step");
  const harnessStep = harnessSteps[0] ?? {};
  if (
    harnessStep.if !== undefined ||
    harnessStep["continue-on-error"] !== undefined ||
    harnessStep.shell !== undefined
  ) {
    violations.push("WIN-284 harness step must be unconditional and fail-fast");
  }
  const reviewedHarness = reviewedTopLevelCommands(harnessStep.run);
  if (
    !reviewedHarness.valid ||
    JSON.stringify(reviewedHarness.commands) !== JSON.stringify(expectedDifferentialHarnessCommands)
  ) {
    violations.push("WIN-284 harness script must contain only the exact reviewed command sequence");
  }

  // WIN-284 — the twin-store conservation job needs a Docker daemon, so it is a
  // separate job. Pinned so the state-conservation half cannot quietly leave.
  const conservationJob = ciJobs.get(expectedDifferentialConservationJob);
  if (conservationJob === undefined) {
    violations.push("CI must retain the WIN-284 twin-store state conservation job");
  } else if (
    countExact(normalizedRunCommands(conservationJob), expectedDifferentialConservationCommand) !== 1
  ) {
    violations.push("WIN-284 twin-store conservation job must run the store gate exactly once");
  }

  const v1Lines = reviewedEvidence.commands;
  const allCiLines = [...ciJobs.values()]
    .flatMap((job) => executableRunValues(job))
    .flatMap((run) =>
      run
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    );
  for (const command of workspaceReachabilityCommands) {
    if (countExact(allCiLines, command) !== 1) {
      violations.push(
        `CI must execute fail-fast WIN-253 workspace reachability gate exactly once in order: ${command}`
      );
    }
  }
  for (const command of win254EvidenceCommands) {
    if (countExact(allCiLines, command) !== 1) {
      violations.push(`CI must execute fail-fast WIN-254 evidence exactly once in order: ${command}`);
    }
  }
  let previousGateIndex = -1;
  for (const command of v1ReleaseGateCommands) {
    const gateIndex = v1Lines.indexOf(command);
    if (
      countExact(v1Lines, command) !== 1 ||
      countExact(allCiLines, command) !== 1 ||
      gateIndex <= previousGateIndex
    ) {
      violations.push(`CI must execute fail-fast V1 gate exactly once in order: ${command}`);
    }
    previousGateIndex = gateIndex;
  }
  let previousGovernanceIndex = v1Lines.indexOf("pnpm test:ci-policy");
  for (const command of repositoryGovernanceCommands) {
    const gateIndex = v1Lines.indexOf(command);
    if (
      countExact(v1Lines, command) !== 1 ||
      countExact(allCiLines, command) !== 1 ||
      gateIndex <= previousGovernanceIndex
    ) {
      violations.push(
        `CI must execute fail-fast repository governance gate exactly once in order: ${command}`
      );
    }
    previousGovernanceIndex = gateIndex;
  }
  const typecheckCommands = normalizedRunCommands(ciJobs.get("typecheck"));
  const allCiCommands = [...ciJobs.values()].flatMap((job) => normalizedRunCommands(job));
  const allCiRunValues = [...ciJobs.values()].flatMap(executableRunValues);
  const webappTypecheck = "pnpm --filter webapp typecheck";
  if (
    countExact(typecheckCommands, webappTypecheck) !== 1 ||
    countExact(allCiCommands, webappTypecheck) !== 1
  ) {
    violations.push("webapp typecheck must be one executable command scoped to the typecheck job");
  }

  let packageManifest = {};
  try {
    packageManifest = JSON.parse(input.packageJson);
  } catch {
    violations.push("package.json must remain valid JSON");
  }
  const packageScripts = packageManifest.scripts ?? {};
  if (Object.hasOwn(packageManifest, "workspaces")) {
    violations.push(
      "package.json must not declare workspaces; pnpm-workspace.yaml is authoritative"
    );
  }
  for (const [name, target] of expectedV1PackageScripts) {
    if (packageScripts[name] !== target)
      violations.push(`package.json must wire exact V1 script ${name}: ${target}`);
  }
  for (const [name, target] of expectedRepositoryGovernanceScripts) {
    if (packageScripts[name] !== target)
      violations.push(
        `package.json must wire exact repository governance script ${name}: ${target}`
      );
  }
  for (const [name, target] of expectedWorkspaceReachabilityScripts) {
    if (packageScripts[name] !== target)
      violations.push(
        `package.json must wire exact workspace reachability script ${name}: ${target}`
      );
  }
  for (const [name, target] of expectedWin254Scripts) {
    if (packageScripts[name] !== target)
      violations.push(`package.json must wire exact WIN-254 script ${name}: ${target}`);
  }
  if (packageScripts.prepare !== `node ${prepareTarget}`) {
    violations.push(`package.json prepare must execute ${prepareTarget}`);
  }
  const agentDockerfile = input.dockerfiles["apps/agent/Dockerfile"] ?? "";
  const agentInstall = agentDockerfile.indexOf("pnpm install --frozen-lockfile");
  const agentRepositoryCopy = agentDockerfile.indexOf("COPY . .");
  if (agentRepositoryCopy === -1 || agentRepositoryCopy > agentInstall) {
    violations.push(
      `apps/agent/Dockerfile must make ${prepareTarget} available before its shipping install`
    );
  }
  const webappDockerfile = input.dockerfiles["apps/webapp/Dockerfile.platos"] ?? "";
  const prepareCopyIndex = webappDockerfile.indexOf(webappPrepareCopy);
  const devStageIndex = webappDockerfile.indexOf("FROM base AS dev-deps");
  const productionStageIndex = webappDockerfile.indexOf("FROM base AS production-deps");
  if (
    prepareCopyIndex === -1 ||
    devStageIndex === -1 ||
    productionStageIndex === -1 ||
    prepareCopyIndex > devStageIndex ||
    prepareCopyIndex > productionStageIndex
  ) {
    violations.push(
      `apps/webapp/Dockerfile.platos must make ${prepareTarget} available in base before both shipping installs`
    );
  }
  if (packageScripts["test:ci-policy"] !== "node --test scripts/ci-policy.test.mjs") {
    violations.push("package.json must wire the CI policy test executable");
  }
  if (packageScripts["build:platos:agent"] !== agentBuildScriptTarget) {
    violations.push("package.json must build workload identity before the strict Agent shipping build");
  }
  if (packageScripts["test:workload-identity-package"] !== workloadPackageTestTarget) {
    violations.push("package.json must wire the workload identity shipping package test");
  }
  if (packageScripts["test:agent-runtime-smoke"] !== agentRuntimeSmokeTestTarget) {
    violations.push("package.json must wire the exact Agent runtime health smoke test");
  }
  if (packageScripts["test:licenses"] !== licenseDeterminismTestTarget) {
    violations.push("package.json must wire the deterministic licence generation test");
  }
  if (packageScripts[persistedStateIntegrationScriptName] !== persistedStateIntegrationTarget) {
    violations.push(
      `package.json must wire exact persisted-state integration alias: ${persistedStateIntegrationTarget}`
    );
  }
  const persistedStateJob = buildJobs.get("persisted-state");
  const persistedStateSteps = workflowSteps(persistedStateJob);
  if (
    persistedStateJob?.if !== undefined ||
    persistedStateJob?.["continue-on-error"] !== undefined ||
    buildWorkflow.defaults?.run?.shell !== undefined ||
    persistedStateJob?.defaults?.run?.shell !== undefined
  ) {
    violations.push(
      "persisted-state job must be unconditional, fail-fast, and free of default-shell bypasses"
    );
  }
  const persistedInstallSteps = persistedStateSteps.filter(
    (step) => step.name === persistedStateInstallDependenciesStepName
  );
  const persistedInstallStep = persistedInstallSteps[0] ?? {};
  const persistedInstallIndex = persistedStateSteps.indexOf(persistedInstallStep);
  const persistedSetupNodeIndices = persistedStateSteps.flatMap((step, index) =>
    typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@") ? [index] : []
  );
  if (
    persistedInstallSteps.length !== 1 ||
    persistedInstallStep.run !== persistedStateInstallDependenciesCommand ||
    persistedInstallStep.if !== undefined ||
    persistedInstallStep["continue-on-error"] !== undefined ||
    persistedInstallStep.shell !== undefined
  ) {
    violations.push(
      "persisted-state install must be the exact unconditional fail-fast frozen lockfile command"
    );
  }
  if (
    persistedSetupNodeIndices.length !== 1 ||
    persistedInstallIndex <= persistedSetupNodeIndices[0]
  ) {
    violations.push("persisted-state exact dependency install must run after setup-node");
  }
  const freshCheckoutWebappWorkflows = [
    ["ci", ciWorkflow, ciJobs],
    ["build-images", buildWorkflow, buildJobs],
  ];
  const reviewedWebappJobs = new Set(["ci/typecheck", "build-images/persisted-state"]);
  const observedWebappJobs = new Set();
  for (const [workflowLabel, workflow, jobs] of freshCheckoutWebappWorkflows) {
    for (const [jobName, job] of jobs) {
      const steps = workflowSteps(job);
      const consumerInvocations = steps.map((step) =>
        directWebappVitestInvocations(step, job, workflow)
      );
      const consumerIndices = consumerInvocations.flatMap((invocations, index) =>
        invocations.length > 0 ? [index] : []
      );
      if (consumerIndices.length === 0) continue;
      const jobKey = `${workflowLabel}/${jobName}`;
      observedWebappJobs.add(jobKey);
      const expectedBuildStepName =
        jobKey === "ci/typecheck"
          ? compiledAgentDependenciesStepName
          : compiledWebappDependenciesStepName;
      const expectedInstallStepName =
        jobKey === "build-images/persisted-state"
          ? persistedStateInstallDependenciesStepName
          : installDependenciesStepName;
      const buildSteps = steps.filter((step) => step.name === expectedBuildStepName);
      const installSteps = steps.filter((step) => step.name === expectedInstallStepName);
      if (buildSteps.length !== 1) {
        violations.push(
          `${jobKey} must contain exactly one accurate compiled Webapp dependency build step`
        );
      }
      const buildStep = buildSteps[0] ?? {};
      if (
        buildStep.run !== compiledAgentDependenciesCommand ||
        buildStep.if !== undefined ||
        buildStep["continue-on-error"] !== undefined ||
        buildStep.shell !== undefined
      ) {
        violations.push(
          `${jobKey} compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides`
        );
      }
      const buildIndex = steps.indexOf(buildStep);
      const installIndex = steps.indexOf(installSteps[0]);
      if (
        installSteps.length !== 1 ||
        installIndex === -1 ||
        buildIndex <= installIndex ||
        consumerIndices.some((index) => index <= buildIndex)
      ) {
        violations.push(
          `${jobKey} compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer`
        );
      }
      if (
        workflow.defaults?.run?.shell !== undefined ||
        job.defaults?.run?.shell !== undefined
      ) {
        violations.push(`${jobKey} Webapp dependency and test steps must not inherit shell defaults`);
      }
      for (const index of consumerIndices) {
        const step = steps[index];
        const expectedShell =
          jobKey === "build-images/persisted-state" &&
          step.name === persistedStateIntegrationStepName
            ? "bash"
            : undefined;
        if (
          step.if !== undefined ||
          step["continue-on-error"] !== undefined ||
          step.shell !== expectedShell
        ) {
          violations.push(
            `${jobKey} direct Webapp Vitest steps must be unconditional and use reviewed fail-fast shells`
          );
        }
        if (hasDirectConsumerSuppression(step.run)) {
          violations.push(
            `${jobKey} direct Webapp Vitest consumers must reject dead-code and control-flow suppression`
          );
        }
        if (hasDirectConsumerSourceAlias(consumerInvocations[index])) {
          violations.push(
            `${jobKey} direct Webapp Vitest consumers must reject source-alias arguments and config`
          );
        }
      }
    }
  }
  if (
    observedWebappJobs.size !== reviewedWebappJobs.size ||
    [...reviewedWebappJobs].some((jobKey) => !observedWebappJobs.has(jobKey))
  ) {
    violations.push("fresh-checkout workflows must retain the exact reviewed Webapp Vitest jobs");
  }
  const memoryPolicySteps = typecheckSteps.filter(
    (step) => step.name === webappMemoryPolicyStepName
  );
  const memoryPolicyStep = memoryPolicySteps[0] ?? {};
  if (
    memoryPolicySteps.length !== 1 ||
    memoryPolicyStep.run !== webappMemoryPolicyCommand ||
    memoryPolicyStep.if !== undefined ||
    memoryPolicyStep["continue-on-error"] !== undefined ||
    memoryPolicyStep.shell !== undefined
  ) {
    violations.push("typecheck must retain the exact fail-fast Webapp memory-policy Vitest step");
  }
  const persistedIntegrationSteps = persistedStateSteps.filter(
    (step) => step.name === persistedStateIntegrationStepName
  );
  const persistedIntegrationStep = persistedIntegrationSteps[0] ?? {};
  if (
    persistedIntegrationSteps.length !== 1 ||
    persistedIntegrationStep.run !== persistedStateIntegrationRun ||
    persistedIntegrationStep.shell !== "bash" ||
    persistedIntegrationStep.if !== undefined ||
    persistedIntegrationStep["continue-on-error"] !== undefined
  ) {
    violations.push(
      "persisted-state must retain the exact fail-fast Webapp integration Vitest step"
    );
  }
  if (packageScripts["audit:webapp-image-inventory"] !== webappInventoryPackageScript) {
    violations.push(`package.json must wire exact webapp inventory script: ${webappInventoryPackageScript}`);
  }
  if (packageManifest.devDependencies?.yaml !== "2.6.1") {
    violations.push("package.json must pin yaml 2.6.1 as an exact root devDependency");
  }
  if (countExact(typecheckCommands, "pnpm test:ci-policy") !== 1) {
    violations.push("typecheck job must execute the wired CI policy test exactly once");
  }
  for (const [command, label] of [
    [workloadPackageTestCommand, "workload identity shipping package"],
    [agentRuntimeSmokeTestCommand, "exact Agent runtime health smoke"],
    [licenseDeterminismTestCommand, "deterministic licence generation"],
  ]) {
    if (countExact(typecheckCommands, command) !== 1 || countExact(allCiCommands, command) !== 1) {
      violations.push(`CI must execute the ${label} test exactly once in typecheck`);
    }
  }
  if (packageScripts["test:win-290"] !== win290ScriptTarget) {
    violations.push("package.json must wire the exact focused WIN-290 suite");
  }
  if (
    countExact(typecheckCommands, win290Command) !== 1 ||
    countExact(allCiCommands, win290Command) !== 1
  ) {
    violations.push("CI must execute the focused WIN-290 suite exactly once in typecheck");
  }
  if (packageScripts["test:win-290:redis"] !== win290RedisScriptTarget) {
    violations.push("package.json must wire the exact WIN-290 real Redis DLQ lifecycle suite");
  }
  const win290RedisSteps = typecheckSteps.filter((step) => step.name === win290RedisStepName);
  if (win290RedisSteps.length !== 1) {
    violations.push(
      "CI must contain exactly one WIN-290 real Redis DLQ lifecycle step in typecheck"
    );
  }
  const win290RedisStep = win290RedisSteps[0] ?? {};
  if (
    win290RedisStep.if !== undefined ||
    win290RedisStep["continue-on-error"] !== undefined ||
    win290RedisStep.shell !== undefined
  ) {
    violations.push("WIN-290 real Redis DLQ lifecycle step must be unconditional and fail-fast");
  }
  if (typecheckJob.if !== undefined || typecheckJob["continue-on-error"] !== undefined) {
    violations.push("WIN-290 real Redis DLQ lifecycle job must be unconditional and fail-fast");
  }
  if (
    ciWorkflow.defaults?.run?.shell !== undefined ||
    typecheckJob.defaults?.run?.shell !== undefined
  ) {
    violations.push(
      "WIN-290 real Redis DLQ lifecycle step must not inherit workflow or job shell defaults"
    );
  }
  const reviewedWin290Redis = reviewedTopLevelCommands(win290RedisStep.run);
  if (
    !reviewedWin290Redis.valid ||
    JSON.stringify(reviewedWin290Redis.commands) !== JSON.stringify([win290RedisCommand])
  ) {
    violations.push("WIN-290 real Redis DLQ lifecycle step must execute only its exact command");
  }
  if (
    JSON.stringify(win290RedisStep.env) !==
    JSON.stringify({ PLATOS_TEST_REDIS_URL: win290RedisUrl })
  ) {
    violations.push("WIN-290 real Redis DLQ lifecycle step must set the exact Redis service URL");
  }
  if (
    JSON.stringify(typecheckJob.services?.["win290-redis"]) !==
    JSON.stringify(expectedWin290RedisService)
  ) {
    violations.push("typecheck job must provide the exact dedicated Redis 7 service for WIN-290");
  }
  if (
    countExact(typecheckCommands, win290RedisCommand) !== 1 ||
    countExact(allCiCommands, win290RedisCommand) !== 1
  ) {
    violations.push(
      "CI must execute the WIN-290 real Redis DLQ lifecycle suite exactly once in typecheck"
    );
  }

  const persistedStateCommands = normalizedRunCommands(buildJobs.get("persisted-state"));
  const inventorySteps = persistedStateSteps.filter((step) => step.name === webappInventoryStepName);
  if (inventorySteps.length !== 1) {
    violations.push("persisted-state must contain exactly one webapp candidate inventory step");
  }
  const inventoryStep = inventorySteps[0] ?? {};
  if (inventoryStep.if !== undefined || inventoryStep["continue-on-error"] !== undefined || inventoryStep.shell !== undefined) {
    violations.push("webapp candidate inventory step must be unconditional and fail-fast");
  }
  if (inventoryStep.run !== webappInventoryCommand ||
      inventoryStep.env?.EVIDENCE_DIR !== "${{ github.workspace }}/artifacts/webapp-image-inventory" ||
      inventoryStep.env?.WEBAPP_CANDIDATE_ARCHIVE !== "${{ github.workspace }}/artifacts/candidates/webapp.oci.tar") {
    violations.push("webapp candidate inventory step must execute the exact archive-backed package command");
  }
  const inventoryStepIndex = persistedStateSteps.indexOf(inventoryStep);
  const loadCandidatesIndex = persistedStateSteps.findIndex((step) => step.name === "Verify and load the exact OCI candidates without registry access");
  const startCandidatesIndex = persistedStateSteps.findIndex((step) => step.name === "Start the exact Agent and webapp candidate pair");
  if (inventoryStepIndex <= loadCandidatesIndex || inventoryStepIndex >= startCandidatesIndex) {
    violations.push("release gate must consume the verified webapp candidate before starting it");
  }
  const allInventoryCommands = [
    ...[...ciJobs.values()].flatMap((job) => normalizedRunCommands(job)),
    ...[...buildJobs.values()].flatMap((job) => normalizedRunCommands(job)),
  ];
  if (countExact(allInventoryCommands, webappInventoryCommand) !== 1) {
    violations.push("webapp candidate inventory package command must execute exactly once in build-images");
  }
  const startCandidatesStep = persistedStateSteps[startCandidatesIndex] ?? {};
  const startCandidatesRun =
    typeof startCandidatesStep.run === "string" ? startCandidatesStep.run : "";
  if (
    countSubstring([input.buildImages], "tests/persisted-state-gate/smoke-agent-runtime-image.sh") !== 1 ||
    !startCandidatesRun.includes(agentRuntimeSmokeInvocation) ||
    startCandidatesRun.indexOf(agentRuntimeSmokeInvocation) <=
      startCandidatesRun.indexOf(
        "docker compose up --detach --no-build --wait --wait-timeout 300 agent webapp"
      )
  ) {
    violations.push(
      "persisted-state must run the exact Agent runtime package and health smoke after starting the candidate"
    );
  }

  const inventoryShellCommands = normalizedShellCommands(input.webappInventoryAudit);
  const verifierCommands = inventoryShellCommands.filter((command) => command.startsWith("node scripts/verify-webapp-image-inventory.mjs --image "));
  if (JSON.stringify(verifierCommands) !== JSON.stringify(expectedWebappInventoryVerifierCommands)) {
    violations.push("webapp inventory audit must verify distinct production-deps and final candidate stages exactly once");
  }
  const expectedProductionBuild = "docker build --platform linux/amd64 --no-cache --target production-deps --build-arg BUILD_GIT_SHA=$git_head --build-arg WEBAPP_INVENTORY_BUILD_INPUTS_SHA256=$inputs_sha256 --file apps/webapp/Dockerfile.platos --tag $production_image .";
  if (!inventoryShellCommands.includes(expectedProductionBuild)) {
    violations.push("webapp inventory audit must build the exact linux/amd64 production-deps stage with required labels");
  }
  const inventoryDockerBuilds = inventoryShellCommands.filter((command) => command.startsWith("docker build "));
  if (JSON.stringify(inventoryDockerBuilds) !== JSON.stringify([expectedProductionBuild])) {
    violations.push("webapp inventory audit must not rebuild the final candidate archive");
  }
  if (!inventoryShellCommands.includes("regctl image import $layout_ref $WEBAPP_CANDIDATE_ARCHIVE") ||
      !inventoryShellCommands.includes("regctl image export --platform linux/amd64 --name $final_image $layout_ref $docker_archive") ||
      !input.webappInventoryAudit.includes("test \"$production_image_id\" != \"$final_image_id\"")) {
    violations.push("webapp inventory audit must load a distinct final image from the exact OCI candidate archive");
  }
  if (!input.webappInventoryAudit.includes("printf 'WIN235_WEBAPP_RUNTIME_IMAGE=%s\\n' \"$final_image\" >> \"$GITHUB_ENV\"")) {
    violations.push("release gate must consume the archive-derived verified webapp runtime image");
  }
  if (countSubstring([input.webappInventoryAudit], webappFinalImageAssignment) !== 1) {
    violations.push(
      "webapp inventory audit must assign the exact manifest-derived verified final image"
    );
  }
  const requiredVerifierControls = [
    "if (platform !== WEBAPP_TARGET_PLATFORM)",
    "labels['org.opencontainers.image.revision'] !== gitHead",
    "labels['dev.winsen.platos.webapp-inventory-inputs-sha256'] !== inputEvidence.sha256",
    "const inventoryByteMatch = generated === committed",
    "if (!inventoryByteMatch || generatedInventorySha256 !== committedInventorySha256)",
    "const archiveIdentity = deriveOciArchiveIdentity({",
    "? assertFinalImageMatchesArchive(inspect, archiveIdentity)",
    "finalImageMatchesArchiveIdentity(evidence, archiveIdentity)",
  ];
  if (requiredVerifierControls.some((control) => !input.webappInventoryVerifier.includes(control))) {
    violations.push("webapp inventory verifier must enforce platform, labels, archive digest, and byte equality");
  }

  const inventoryUploadSteps = persistedStateSteps.filter((step) => step.name === webappInventoryUploadStepName);
  const inventoryUpload = inventoryUploadSteps[0] ?? {};
  if (inventoryUploadSteps.length !== 1 ||
      inventoryUpload.if !== "always()" ||
      inventoryUpload.uses !== "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" ||
      inventoryUpload.with?.name !== "win253-webapp-image-inventory-${{ steps.webapp-inventory.outputs.candidate_manifest_digest || 'unverified' }}-${{ github.run_id }}-${{ github.run_attempt }}" ||
      inventoryUpload.with?.path !== "artifacts/webapp-image-inventory" ||
      inventoryUpload.with?.["if-no-files-found"] !== "error") {
    violations.push("build-images must retain manifest-keyed webapp candidate inventory evidence");
  }
  for (const command of relocatedCommands) {
    if (countExact(typecheckCommands, command) !== 1) {
      violations.push(`typecheck job must execute relocated command: ${command}`);
    }
    if (countSubstring(allCiRunValues, command) !== 1) {
      violations.push(`CI must execute relocated command exactly once across all jobs: ${command}`);
    }
    if (
      persistedStateCommands.some((persistedCommand) =>
        persistedCommand.includes(relocatedSelector(command))
      )
    ) {
      violations.push(`persisted-state job must not execute relocated command: ${command}`);
    }
  }

  const buildSteps = allWorkflowSteps(buildWorkflow);
  const permissions = permissionDeclarations(buildWorkflow);
  if (
    permissions.some(
      (declaration) =>
        declaration !== null && typeof declaration === "object" && declaration.packages === "write"
    )
  ) {
    violations.push("build-images grants package write permission");
  }
  if (permissions.some((declaration) => declaration === "write-all")) {
    violations.push("build-images grants write-all permission");
  }
  if (
    buildSteps.some(
      (step) => typeof step.uses === "string" && step.uses.startsWith("docker/login-action@")
    )
  ) {
    violations.push("build-images contains a registry login action");
  }
  if (buildAction?.with?.push !== false) violations.push("build-push action must keep push false");
  const outputs = buildAction?.with?.outputs;
  if (typeof outputs !== "string" || /\btype\s*=\s*(?:registry|image)\b/iu.test(outputs)) {
    violations.push("build-push action contains a registry-capable exporter");
  }
  const shellArgv = [...buildJobs.values()]
    .flatMap(executableRunCommands)
    .map(executableShellArgv)
    .filter((argv) => argv.length > 0);
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      if (tool === "eval") return true;
      if (!shellInterpreters.has(tool)) return false;
      return arguments_.some(
        (argument) => argument === "--command" || /^-[a-z]*c[a-z]*$/iu.test(argument)
      );
    })
  ) {
    violations.push("build-images contains executable shell command indirection");
  }
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      return (
        (tool === "docker" && arguments_.includes("login")) ||
        (tool === "regctl" && arguments_.includes("login")) ||
        ((tool === "oras" || tool === "skopeo") && arguments_.includes("login"))
      );
    })
  ) {
    violations.push("build-images contains an executable shell registry login");
  }
  if (
    shellArgv.some((argv) => {
      const [tool, ...arguments_] = argv.map((word) => word.toLowerCase());
      if (tool === "regctl") return arguments_.includes("copy") || arguments_.includes("import");
      if (tool === "oras") return arguments_.includes("push");
      if (tool === "skopeo") return arguments_.includes("copy");
      if (tool !== "docker") return false;
      if (arguments_.includes("push")) return true;
      const buildx = arguments_.indexOf("buildx");
      if (buildx === -1) return false;
      const buildxArguments = arguments_.slice(buildx + 1);
      if (buildxArguments.includes("imagetools") && buildxArguments.includes("create")) return true;
      if (!buildxArguments.includes("build")) return false;
      if (arguments_.some((argument) => /^--push(?:=(?:true|1))?$/iu.test(argument))) return true;
      return arguments_.some(
        (argument, index) =>
          /^(?:--output|-o)=?type=(?:registry|image)(?:,|$)/iu.test(argument) ||
          (/^(?:--output|-o)$/iu.test(argument) &&
            /^type=(?:registry|image)(?:,|$)/iu.test(arguments_[index + 1] ?? ""))
      );
    })
  ) {
    violations.push("build-images contains an executable shell publication command");
  }
  if (
    shellArgv.some((argv) =>
      /(?:deploy-platos\.sh|trigger\.dev@\S+\s+(?:deploy|promote)|kubectl\s+apply|helm\s+(?:install|upgrade))/u.test(
        argv.join(" ")
      )
    )
  ) {
    violations.push("build-images contains an executable deployment command");
  }

  return violations;
}

function replaceNth(sourceText, before, after, occurrence) {
  assert.ok(occurrence >= 0, "mutation occurrence must be non-negative");
  let cursor = 0;
  let found = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    found = sourceText.indexOf(before, cursor);
    assert.notEqual(
      found,
      -1,
      `mutation source is missing occurrence ${occurrence + 1} of ${JSON.stringify(before)}`
    );
    cursor = found + before.length;
  }
  const changed = `${sourceText.slice(0, found)}${after}${sourceText.slice(found + before.length)}`;
  assert.notEqual(changed, sourceText, "fixture mutation must change source");
  return changed;
}

function mutateFixture(input, key, before, after, options = {}) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing string fixture ${key}`);
  const changed = options.all
    ? (() => {
        assert.ok(
          original.includes(before),
          `${key} mutation source is missing ${JSON.stringify(before)}`
        );
        return original.replaceAll(before, after);
      })()
    : replaceNth(original, before, after, options.occurrence ?? 0);
  assert.notEqual(changed, original, `${key} fixture mutation must change source`);
  return { ...input, [key]: changed };
}

function wrapEvidenceCommand(input, command, lines) {
  return mutateFixture(input, "ci", command, lines.join("\n          "));
}

function mutateDockerfile(input, file, before, after, options = {}) {
  const original = input.dockerfiles[file];
  assert.equal(typeof original, "string", `missing Dockerfile fixture ${file}`);
  const changed = options.all
    ? (() => {
        assert.ok(
          original.includes(before),
          `${file} mutation source is missing ${JSON.stringify(before)}`
        );
        return original.replaceAll(before, after);
      })()
    : replaceNth(original, before, after, options.occurrence ?? 0);
  assert.notEqual(changed, original, `${file} fixture mutation must change source`);
  return { ...input, dockerfiles: { ...input.dockerfiles, [file]: changed } };
}

function mutateDockerInstallInstruction(input, file, occurrence, expectedInstruction, before, after) {
  const original = input.dockerfiles[file];
  assert.equal(typeof original, "string", `missing Dockerfile fixture ${file}`);
  const lines = original.split("\n");
  let installIndex = 0;
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^\s*RUN(?:\s|$)/iu.test(lines[start])) continue;
    let end = start;
    while (lines[end].trimEnd().endsWith("\\") && end + 1 < lines.length) end += 1;
    const rawInstruction = lines.slice(start, end + 1).join("\n");
    const normalizedInstruction = dockerRunInstructions(rawInstruction)[0];
    if (!containsExecutablePnpmInstall(normalizedInstruction)) {
      start = end;
      continue;
    }
    if (installIndex !== occurrence) {
      installIndex += 1;
      start = end;
      continue;
    }
    assert.equal(normalizedInstruction, expectedInstruction, `${file} executable install mutation must select the expected RUN`);
    assert.ok(rawInstruction.includes(before), `${file} install mutation source is missing ${JSON.stringify(before)}`);
    lines.splice(start, end - start + 1, ...rawInstruction.replace(before, after).split("\n"));
    const changed = lines.join("\n");
    assert.notEqual(changed, original, `${file} install mutation must change source`);
    return { ...input, dockerfiles: { ...input.dockerfiles, [file]: changed } };
  }
  assert.fail(`${file} mutation source is missing executable install ${occurrence + 1}`);
}

function mutateEventSelector(input, key, eventName) {
  const before = `  ${eventName}:\n    branches: [main, v1]`;
  const after = `  ${eventName}:\n    branches: [main]`;
  return mutateFixture(input, key, before, after);
}

function insertBuildCandidateStep(input, step) {
  return insertWorkflowJobStep(input, "buildImages", "build-candidates", step);
}

function insertWorkflowJobStep(input, key, jobName, step) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing workflow fixture ${key}`);
  const document = parseDocument(original, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${key} fixture must be valid YAML`);
  const workflow = document.toJS();
  const steps = workflow?.jobs?.[jobName]?.steps;
  assert.ok(Array.isArray(steps), `${jobName} job is missing steps in ${key}`);
  steps.unshift(step);
  document.contents = document.createNode(workflow);
  const changed = String(document);
  assert.notEqual(changed, original, "workflow job insertion must change source");
  return { ...input, [key]: changed };
}

function mutateWorkflowJobSteps(input, key, jobName, mutate) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing workflow fixture ${key}`);
  const document = parseDocument(original, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${key} fixture must be valid YAML`);
  const workflow = document.toJS();
  const steps = workflow?.jobs?.[jobName]?.steps;
  assert.ok(Array.isArray(steps), `${jobName} job is missing steps in ${key}`);
  mutate(steps);
  document.contents = document.createNode(workflow);
  const changed = String(document);
  assert.notEqual(changed, original, "workflow job step mutation must change source");
  return { ...input, [key]: changed };
}

function mutateWorkflowJob(input, key, jobName, mutate) {
  const original = input[key];
  assert.equal(typeof original, "string", `missing workflow fixture ${key}`);
  const document = parseDocument(original, { prettyErrors: false, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${key} fixture must be valid YAML`);
  const workflow = document.toJS();
  const job = workflow?.jobs?.[jobName];
  assert.ok(job !== null && typeof job === "object", `${jobName} job is missing in ${key}`);
  mutate(job);
  document.contents = document.createNode(workflow);
  const changed = String(document);
  assert.notEqual(changed, original, "workflow job mutation must change source");
  return { ...input, [key]: changed };
}

test("committed CI and image-build policy is executable, correlated, and complete", () => {
  assert.equal(expectedCandidates.length, 3, "candidate selector must be non-empty and explicit");
  assert.equal(
    shippingDockerfiles.length,
    3,
    "shipping Dockerfile selector must be non-empty and explicit"
  );
  assert.equal(
    [...expectedInstallInstructions.values()].reduce(
      (total, instructions) => total + instructions.length,
      0
    ),
    4,
    "shipping install selector must cover all four executable installs"
  );
  assert.equal(
    relocatedCommands.length,
    7,
    "relocated command selector must cover all seven commands"
  );
  // M2 INTEGRATION DELTA — 16 -> 26. Four branches add release gates on
  // independent axes, so the pinned count is their SUM:
  //   +1 WIN-299 (M2.6): audit:advisory:nonvacuity.
  //   +5 WIN-256: the two gates ADR M0.3 specifies that M1 did not build —
  //      §5.3 kernel-content (audit + test) and §5.2 sole-writer (audit +
  //      test) — plus test:v1-packages, which runs the V1 packages' own suites
  //      now that packages/kernel holds real code and 44 real assertions.
  //   +2 WIN-297: composition-root (audit + test), which narrows rule (j) from
  //      a package to one file and carries the real-tree negative controls for
  //      rules (j) and (a).
  //   +2 WIN-260 (M2.5): env-access (audit + test), which turns "feature code
  //      does not read process.env" into a counted, pinned property — the same
  //      containment shape ADR M0.3 §15 gave the ORM, on the one input nothing
  //      in the repository had ever looked at.
  //   +2 WIN-260 (M2.5, outbox/clock/retry): transaction-outcome (audit +
  //      test), which gives the type-level transaction-outcome refusal a named
  //      case that can go red. A guard nothing can turn red is a guard that is
  //      not there, and a TYPE guard is the easiest kind to lose that way.
  // 26 + 2 = 28.
  assert.equal(
    v1ReleaseGateCommands.length,
    28,
    "V1 release gate selector must cover existing gates plus image/advisory contract verification, disposition non-vacuity, the ADR M0.3 kernel-content and sole-writer gates, the composition-root gate, the env-access gate and the transaction-outcome gate"
  );
  assert.equal(
    repositoryGovernanceCommands.length,
    5,
    "repository governance selector must cover manifest and hook policy commands"
  );
  assert.equal(
    workspaceReachabilityCommands.length,
    2,
    "workspace reachability selector must cover test then audit"
  );
  assert.equal(
    win254EvidenceCommands.length,
    6,
    "WIN-254 selector must cover four focused suites, composition policy, and the combined verifier"
  );
  assert.deepEqual(policyViolations(fixtures()), []);
});

test("CI policy controls fail under generated semantic source mutations", async (t) => {
  const pristine = fixtures();
  const controls = [];

  for (const [key, label] of [
    ["ci", "ci.yml"],
    ["buildImages", "build-images.yml"],
  ]) {
    for (const eventName of ["push", "pull_request"]) {
      controls.push({
        name: `${label} ${eventName} selector`,
        expected: `${label} ${eventName} must select exactly main and v1`,
        mutate: (input) => mutateEventSelector(input, key, eventName),
      });
    }
  }

  for (const [file, expectedInstructions] of expectedInstallInstructions) {
    for (let occurrence = 0; occurrence < expectedInstructions.length; occurrence += 1) {
      controls.push(
        {
          name: `${file} executable install ${occurrence + 1} selector`,
          expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
          mutate: (input) =>
            mutateDockerInstallInstruction(
              input,
              file,
              occurrence,
              expectedInstructions[occurrence],
              "pnpm install",
              "# pnpm install"
            ),
        },
        {
          name: `${file} executable install ${occurrence + 1} frozen lockfile`,
          expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
          mutate: (input) =>
            mutateDockerInstallInstruction(
              input,
              file,
              occurrence,
              expectedInstructions[occurrence],
              "--frozen-lockfile",
              "--no-frozen-lockfile"
            ),
        }
      );
    }
    controls.push({
      name: `${file} non-empty executable install selector`,
      expected: `${file} must contain only its exact frozen pnpm install RUN instruction(s)`,
      mutate: (input) =>
        mutateDockerfile(input, file, "pnpm install", "# pnpm install", { all: true }),
    });
  }

  for (const [key, count] of expectedSetupNodeCounts) {
    const label = key === "ci" ? "ci.yml" : "build-images.yml";
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      controls.push({
        name: `${label} setup-node ${occurrence + 1}`,
        expected: `${label} setup-node must derive its version from .nvmrc`,
        mutate: (input) =>
          mutateFixture(input, key, "node-version-file: .nvmrc", "node-version: 20.20.0", {
            occurrence,
          }),
      });
    }
  }

  for (const modifier of ["|-", "|+", ">-", ">+"]) {
    controls.push({
      name: `block scalar ${modifier} registry exporter publication`,
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          `outputs: ${modifier}\n            type=registry`
        ),
    });
  }

  controls.push(
    {
      name: "typecheck checkout depth change",
      expected: "typecheck checkout must retain fetch-depth 0",
      mutate: (input) => mutateFixture(input, "ci", "fetch-depth: 0", "fetch-depth: 1"),
    },
    {
      name: "typecheck checkout depth removal",
      expected: "typecheck checkout must retain fetch-depth 0",
      mutate: (input) => mutateFixture(input, "ci", "fetch-depth: 0", "fetch-depth: null"),
    },
    {
      name: "reviewed-source fetch step removal",
      expected: "CI must contain exactly one reviewed-source immutable tag fetch step",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const index = steps.findIndex((step) => step.name === reviewedSourceFetchStepName);
          assert.notEqual(index, -1);
          steps.splice(index, 1);
        }),
    },
    {
      name: "reviewed-source fetch reordered after setup",
      expected: "reviewed-source immutable tag fetch must run immediately after typecheck checkout",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const index = steps.findIndex((step) => step.name === reviewedSourceFetchStepName);
          assert.notEqual(index, -1);
          const [step] = steps.splice(index, 1);
          steps.splice(index + 1, 0, step);
        }),
    },
    {
      name: "reviewed-source fetch exact tag change",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) => mutateFixture(input, "ci", reviewedSourceTag, `${reviewedSourceTag.slice(0, -1)}1`),
    },
    {
      name: "reviewed-source fetch exact commit change",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) =>
        mutateFixture(input, "ci", `REVIEWED_SOURCE_COMMIT: ${reviewedSourceCommit}`, `REVIEWED_SOURCE_COMMIT: ${reviewedSourceCommit.slice(0, -1)}1`),
    },
    {
      name: "reviewed-source mutable branch fetch",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) => mutateFixture(input, "ci", "refs/tags/provenance/", "refs/heads/"),
    },
    {
      name: "reviewed-source raw SHA fetch",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          '"${REVIEWED_SOURCE_TAG}:${REVIEWED_SOURCE_REF}"',
          '"${REVIEWED_SOURCE_COMMIT}:${REVIEWED_SOURCE_REF}"'
        ),
    },
    {
      name: "reviewed-source public local branch ref",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) => mutateFixture(input, "ci", "refs/platos-ci/provenance/", "refs/heads/"),
    },
    {
      name: "reviewed-source fetch success bypass",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) =>
        mutateFixture(input, "ci", '"${REVIEWED_SOURCE_TAG}:${REVIEWED_SOURCE_REF}"', '"${REVIEWED_SOURCE_TAG}:${REVIEWED_SOURCE_REF}" || true'),
    },
    {
      name: "reviewed-source peel removal",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) => mutateFixture(input, "ci", "${REVIEWED_SOURCE_REF}^{commit}", "${REVIEWED_SOURCE_REF}"),
    },
    {
      name: "reviewed-source equality self-comparison",
      expected:
        "reviewed-source fetch must use the exact immutable tag, private ref, peeled commit, and equality check",
      mutate: (input) =>
        mutateFixture(input, "ci", 'test "$resolved_commit" = "$REVIEWED_SOURCE_COMMIT"', 'test "$resolved_commit" = "$resolved_commit"'),
    },
    {
      name: "conditional reviewed-source fetch",
      expected: "reviewed-source immutable tag fetch must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${reviewedSourceFetchStepName}\n        env:`,
          `      - name: ${reviewedSourceFetchStepName}\n        if: \${{ false }}\n        env:`
        ),
    },
    {
      name: "continue-on-error reviewed-source fetch",
      expected: "reviewed-source immutable tag fetch must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${reviewedSourceFetchStepName}\n        env:`,
          `      - name: ${reviewedSourceFetchStepName}\n        continue-on-error: true\n        env:`
        ),
    },
    {
      name: "compiled Agent dependencies build step removal",
      expected: "CI must contain exactly one compiled Agent dependencies build step",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const index = steps.findIndex(
            (step) => step.name === compiledAgentDependenciesStepName
          );
          assert.notEqual(index, -1);
          steps.splice(index, 1);
        }),
    },
    {
      name: "workload-identity dist build removal",
      expected:
        "compiled Agent dependencies step must fail-fast on the exact tenancy and workload-identity dist builds",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          compiledAgentDependenciesCommand,
          "pnpm --filter @platos/tenancy-database build"
        ),
    },
    {
      name: "compiled Agent dependencies reordered before install",
      expected:
        "compiled Agent dependencies must build after install and before every direct Agent Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledAgentDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          const [buildStep] = steps.splice(buildIndex, 1);
          const installIndex = steps.findIndex((step) => step.name === installDependenciesStepName);
          assert.notEqual(installIndex, -1);
          steps.splice(installIndex, 0, buildStep);
        }),
    },
    {
      name: "compiled Agent dependencies reordered after direct Agent tests",
      expected:
        "compiled Agent dependencies must build after install and before every direct Agent Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledAgentDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          const [buildStep] = steps.splice(buildIndex, 1);
          const consumerIndex = steps.findIndex(
            (step) => step.name === focusedDirectAgentTestStepName
          );
          assert.notEqual(consumerIndex, -1);
          steps.splice(consumerIndex + 1, 0, buildStep);
        }),
    },
    {
      name: "workload-identity source-alias bypass",
      expected:
        "compiled Agent dependencies step must fail-fast on the exact tenancy and workload-identity dist builds",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          compiledAgentDependenciesCommand,
          "pnpm --filter @platos/tenancy-database build && echo '@internal/workload-identity=internal-packages/workload-identity/src/index.ts' > /var/tmp/agent-source-alias"
        ),
    },
    {
      name: "workload-identity build no-op bypass",
      expected:
        "compiled Agent dependencies step must fail-fast on the exact tenancy and workload-identity dist builds",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          compiledAgentDependenciesCommand,
          `${compiledAgentDependenciesCommand} || true`
        ),
    },
    {
      name: "focused direct Agent Vitest true-or bypass",
      expected:
        "focused direct Agent hosted-CI reproduction must be one dedicated exact fail-fast run step",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === focusedDirectAgentTestStepName
          );
          assert.ok(step);
          step.run = `${focusedDirectAgentTestCommand} || true`;
        }),
    },
    {
      name: "focused direct Agent Vitest exit-zero dead code",
      expected:
        "focused direct Agent hosted-CI reproduction must be one dedicated exact fail-fast run step",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === focusedDirectAgentTestStepName
          );
          assert.ok(step);
          step.run = `exit 0\n${focusedDirectAgentTestCommand}`;
        }),
    },
    {
      name: "conditional direct Agent Vitest step",
      expected: "every direct Agent Vitest step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === focusedDirectAgentTestStepName
          );
          assert.ok(step);
          step.if = "${{ false }}";
        }),
    },
    {
      name: "continue-on-error direct Agent Vitest step",
      expected: "every direct Agent Vitest step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === focusedDirectAgentTestStepName
          );
          assert.ok(step);
          step["continue-on-error"] = true;
        }),
    },
    {
      name: "shell override direct Agent Vitest step",
      expected: "every direct Agent Vitest step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "ci", "typecheck", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === focusedDirectAgentTestStepName
          );
          assert.ok(step);
          step.shell = "bash {0} || true";
        }),
    },
    {
      name: "successful no-op webapp publication provenance validator",
      expected: "publish-images must execute the exact webapp publication provenance validator once",
      mutate: (input) =>
        mutateFixture(
          input,
          "publishImages",
          [
            "node scripts/verify-webapp-publication-provenance.mjs \\",
            "            --candidate-identities artifacts/gate/candidate-images.json \\",
            "            --inventory-root artifacts/webapp-inventory",
          ].join("\n"),
          "node -e 'process.exit(0)'",
        ),
    },
    ...requiredWebappPublicationValidatorControls.map(([name, control, shortCircuit]) => ({
      name: `short-circuited webapp publication ${name}`,
      expected: "webapp publication validator must enforce every bound provenance field",
      mutate: (input) =>
        mutateFixture(input, "webappPublicationValidator", control, shortCircuit),
    })),
    {
      name: "successful no-op webapp inventory package script",
      expected: `package.json must wire exact webapp inventory script: ${webappInventoryPackageScript}`,
      mutate: (input) => mutateFixture(input, "packageJson", webappInventoryPackageScript, "node -p 0"),
    },
    {
      name: "successful no-op webapp candidate inventory step",
      expected: "webapp candidate inventory step must execute the exact archive-backed package command",
      mutate: (input) => mutateFixture(input, "buildImages", webappInventoryCommand, "echo skipped-webapp-inventory"),
    },
    {
      name: "skipped webapp candidate inventory step",
      expected: "webapp candidate inventory step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          `      - name: ${webappInventoryStepName}\n        id: webapp-inventory`,
          `      - name: ${webappInventoryStepName}\n        id: webapp-inventory\n        if: \${{ false }}`
        ),
    },
    {
      name: "continue-on-error webapp candidate inventory step",
      expected: "webapp candidate inventory step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          `      - name: ${webappInventoryStepName}\n        id: webapp-inventory`,
          `      - name: ${webappInventoryStepName}\n        id: webapp-inventory\n        continue-on-error: true`
        ),
    },
    {
      name: "same image verified twice",
      expected: "webapp inventory audit must verify distinct production-deps and final candidate stages exactly once",
      mutate: (input) => mutateFixture(input, "webappInventoryAudit", '--image "$final_image"', '--image "$production_image"'),
    },
    {
      name: "drop production-deps inventory stage",
      expected: "webapp inventory audit must verify distinct production-deps and final candidate stages exactly once",
      mutate: (input) => mutateFixture(input, "webappInventoryAudit", "--stage production-deps", "--stage omitted-production-deps"),
    },
    {
      name: "drop final candidate inventory stage",
      expected: "webapp inventory audit must verify distinct production-deps and final candidate stages exactly once",
      mutate: (input) => mutateFixture(input, "webappInventoryAudit", "--stage final", "--stage omitted-final"),
    },
    {
      name: "non-amd64 webapp candidate",
      expected: "build-push action must produce only the linux/amd64 candidate",
      mutate: (input) => mutateFixture(input, "buildImages", "platforms: linux/amd64", "platforms: linux/arm64"),
    },
    {
      name: "non-amd64 production-deps verification",
      expected: "webapp inventory audit must build the exact linux/amd64 production-deps stage with required labels",
      mutate: (input) => mutateFixture(input, "webappInventoryAudit", "--platform linux/amd64", "--platform linux/arm64"),
    },
    {
      name: "missing candidate inventory build argument",
      expected: "build-push action must apply the exact revision and webapp inventory build-input digest",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "WEBAPP_INVENTORY_BUILD_INPUTS_SHA256=${{ steps.webapp-inventory-inputs.outputs.sha256 }}",
          "WEBAPP_INVENTORY_BUILD_INPUTS_SHA256=missing"
        ),
    },
    {
      name: "missing candidate inventory digest label",
      expected: "build-push action must label the candidate with revision and inventory build-input digest",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "dev.winsen.platos.webapp-inventory-inputs-sha256=${{ steps.webapp-inventory-inputs.outputs.sha256 }}",
          "dev.winsen.platos.webapp-inventory-inputs-sha256=missing"
        ),
    },
    {
      name: "missing candidate revision label",
      expected: "build-push action must label the candidate with revision and inventory build-input digest",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "org.opencontainers.image.revision=${{ env.PLATOS_CANDIDATE_SHA }}",
          "org.opencontainers.image.revision=missing"
        ),
    },
    {
      name: "successful no-op candidate build-input digest",
      expected: "build-candidates must compute the exact webapp inventory build-input digest once",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          'echo "sha256=$(node scripts/verify-webapp-image-inventory.mjs --print-build-inputs-sha256)" >> "$GITHUB_OUTPUT"',
          'echo "sha256=$(printf 0)" >> "$GITHUB_OUTPUT"'
        ),
    },
    {
      name: "disabled inventory byte comparison",
      expected: "webapp inventory verifier must enforce platform, labels, archive digest, and byte equality",
      mutate: (input) => mutateFixture(input, "webappInventoryVerifier", "const inventoryByteMatch = generated === committed", "const inventoryByteMatch = true"),
    },
    {
      name: "missing candidate archive manifest blob comparison",
      expected:
        "shared webapp archive contract must bind descriptor, manifest, config, and portable image identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryContract",
          "manifestDigest !== descriptor.digest",
          "manifestDigest === descriptor.digest"
        ),
    },
    {
      name: "missing final archive config image ID comparison",
      expected: "webapp inventory verifier must enforce platform, labels, archive digest, and byte equality",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryVerifier",
          "? assertFinalImageMatchesArchive(inspect, archiveIdentity)",
          "? assertFinalImageMatchesUnreviewedArchive(inspect, archiveIdentity)"
        ),
    },
    {
      name: "no-op shared archive image identity predicate",
      expected:
        "shared webapp archive contract must bind descriptor, manifest, config, and portable image identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryContract",
          "evidence?.imageId === archiveIdentity?.configDigest",
          "archiveIdentity?.configDigest === archiveIdentity?.configDigest"
        ),
    },
    {
      name: "missing shared archive descriptor size comparison",
      expected:
        "shared webapp archive contract must bind descriptor, manifest, config, and portable image identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryContract",
          "manifestSize !== descriptor.size",
          "manifestSize === descriptor.size"
        ),
    },
    {
      name: "deleted performance archive identity derivation",
      expected:
        "performance runner and verifier must independently enforce archive-derived webapp identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "performanceVerifier",
          "archiveIdentity = deriveOciArchiveIdentity({",
          "archiveIdentity = deriveOciArchiveIdentityNoOp({"
        ),
    },
    {
      name: "no-op performance archive image identity predicate",
      expected:
        "performance runner and verifier must independently enforce archive-derived webapp identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "performanceVerifier",
          "finalImageMatchesArchiveIdentity(evidence, archiveIdentity)",
          "finalImageMatchesArchiveIdentity(archiveIdentity, archiveIdentity)"
        ),
    },
    {
      name: "performance runner omits exact candidate archive path",
      expected:
        "performance runner and verifier must independently enforce archive-derived webapp identity",
      mutate: (input) =>
        mutateFixture(
          input,
          "performanceRunner",
          "webappCandidateArchivePath(artifactDirectory)",
          "undefined"
        ),
    },
    {
      name: "missing candidate build-input label validation",
      expected: "webapp inventory verifier must enforce platform, labels, archive digest, and byte equality",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryVerifier",
          "labels['dev.winsen.platos.webapp-inventory-inputs-sha256'] !== inputEvidence.sha256",
          "labels['dev.winsen.platos.webapp-inventory-inputs-sha256'] === inputEvidence.sha256"
        ),
    },
    {
      name: "dropped manifest-keyed evidence upload",
      expected: "build-images must retain manifest-keyed webapp candidate inventory evidence",
      mutate: (input) => mutateFixture(input, "buildImages", "path: artifacts/webapp-image-inventory", "path: artifacts/missing-webapp-image-inventory"),
    },
    {
      name: "warning-only manifest-keyed evidence upload",
      expected: "build-images must retain manifest-keyed webapp candidate inventory evidence",
      mutate: (input) => mutateFixture(input, "buildImages", "if-no-files-found: error", "if-no-files-found: warn", { occurrence: 1 }),
    },
    {
      name: "final verification imports a different archive",
      expected: "webapp inventory audit must load a distinct final image from the exact OCI candidate archive",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryAudit",
          "regctl image import \"$layout_ref\" \"$WEBAPP_CANDIDATE_ARCHIVE\"",
          "regctl image import \"$layout_ref\" /var/tmp/unverified.oci.tar"
        ),
    },
    {
      name: "final candidate is rebuilt separately",
      expected: "webapp inventory audit must not rebuild the final candidate archive",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryAudit",
          'docker load --input "$docker_archive"',
          'docker load --input "$docker_archive"\ndocker build --tag unverified-final .'
        ),
    },
    {
      name: "release gate retains unverified runtime image",
      expected: "release gate must consume the archive-derived verified webapp runtime image",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryAudit",
          "printf 'WIN235_WEBAPP_RUNTIME_IMAGE=%s\\n' \"$final_image\"",
          "printf 'WIN235_WEBAPP_RUNTIME_IMAGE=%s\\n' \"$production_image\""
        ),
    },
    {
      name: "webapp inventory changes exact final image assignment",
      expected:
        "webapp inventory audit must assign the exact manifest-derived verified final image",
      mutate: (input) =>
        mutateFixture(
          input,
          "webappInventoryAudit",
          webappFinalImageAssignment,
          'final_image="win235.local/platos-webapp:sha256-$candidate_digest_hex"'
        ),
    },
    ...v1ReleaseGateCommands.map((command) => ({
      name: `fail-fast V1 gate ${command}`,
      expected: `CI must execute fail-fast V1 gate exactly once in order: ${command}`,
      mutate: (input) => mutateFixture(input, "ci", command, `${command} || true`),
    })),
    ...repositoryGovernanceCommands.flatMap((command) => [
      {
        name: `fail-fast repository governance gate ${command}`,
        expected: `CI must execute fail-fast repository governance gate exactly once in order: ${command}`,
        mutate: (input) => mutateFixture(input, "ci", command, `echo skipped # ${command}`),
      },
      {
        name: `globally unique repository governance gate ${command}`,
        expected: `CI must execute fail-fast repository governance gate exactly once in order: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
            name: "Duplicate governance gate",
            run: command,
          }),
      },
    ]),
    ...workspaceReachabilityCommands.flatMap((command) => [
      {
        name: `skipped WIN-253 workspace reachability gate ${command}`,
        expected: `CI must execute fail-fast WIN-253 workspace reachability gate exactly once in order: ${command}`,
        mutate: (input) => mutateFixture(input, "ci", command, `echo skipped # ${command}`),
      },
      {
        name: `globally duplicated WIN-253 workspace reachability gate ${command}`,
        expected: `CI must execute fail-fast WIN-253 workspace reachability gate exactly once in order: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
            name: "Duplicate reachability gate",
            run: command,
          }),
      },
    ]),
    {
      name: "reordered WIN-253 workspace reachability gates",
      expected:
        "WIN-253 workspace reachability evidence script must contain only the exact reviewed command sequence",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          workspaceReachabilityCommands.join("\n          "),
          [...workspaceReachabilityCommands].reverse().join("\n          ")
        ),
    },
    ...[
      ["if false", ["if false; then", workspaceReachabilityCommands[0], "fi"]],
      ["subshell", ["(", workspaceReachabilityCommands[0], ")"]],
      ["interpreter wrapper", [`bash -c '${workspaceReachabilityCommands[0]}'`]],
      ["exit 0", ["exit 0", workspaceReachabilityCommands[0]]],
      ["exec true", ["exec true", workspaceReachabilityCommands[0]]],
    ].map(([name, lines]) => ({
      name: `WIN-253 workspace reachability ${name} cannot hide or terminate the gate`,
      expected:
        "WIN-253 workspace reachability evidence script must contain only the exact reviewed command sequence",
      mutate: (input) => wrapEvidenceCommand(input, workspaceReachabilityCommands[0], lines),
    })),
    ...win254EvidenceCommands.flatMap((command) => [
      {
        name: `removed WIN-254 evidence command ${command}`,
        expected: "WIN-254 evidence script must contain only the exact reviewed command sequence",
        mutate: (input) => mutateFixture(input, "ci", command, `echo removed # ${command}`),
      },
      {
        name: `duplicated WIN-254 evidence command ${command}`,
        expected: `CI must execute fail-fast WIN-254 evidence exactly once in order: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
            name: "Duplicate WIN-254 evidence",
            run: command,
          }),
      },
    ]),
    ...[
      ["if false", ["if false; then", win254EvidenceCommands[0], "fi"]],
      ["subshell", ["(", win254EvidenceCommands[0], ")"]],
      ["interpreter wrapper", [`bash -c '${win254EvidenceCommands[0]}'`]],
      ["exit 0", ["exit 0", win254EvidenceCommands[0]]],
      ["exec true", ["exec true", win254EvidenceCommands[0]]],
    ].map(([name, lines]) => ({
      name: `WIN-254 evidence ${name} cannot hide or terminate the gate`,
      expected: "WIN-254 evidence script must contain only the exact reviewed command sequence",
      mutate: (input) => wrapEvidenceCommand(input, win254EvidenceCommands[0], lines),
    })),
    ...[
      ["if false", ["if false; then", repositoryGovernanceCommands[0], "fi"]],
      ["case", ["case x in", `x) ${repositoryGovernanceCommands[0]} ;;`, "esac"]],
      ["for loop", ["for x in one; do", repositoryGovernanceCommands[0], "done"]],
      ["while loop", ["while false; do", repositoryGovernanceCommands[0], "done"]],
      ["until loop", ["until true; do", repositoryGovernanceCommands[0], "done"]],
      [
        "function",
        ["governance_gate() {", repositoryGovernanceCommands[0], "}", "governance_gate"],
      ],
      ["subshell", ["(", repositoryGovernanceCommands[0], ")"]],
      ["eval", [`eval '${repositoryGovernanceCommands[0]}'`]],
      ["interpreter wrapper", [`bash -c '${repositoryGovernanceCommands[0]}'`]],
      ["exit 0", ["exit 0", repositoryGovernanceCommands[0]]],
      ["exec true", ["exec true", repositoryGovernanceCommands[0]]],
    ].map(([name, lines]) => ({
      name: `V1 evidence ${name} cannot hide a required command`,
      expected: "V1 evidence script must contain only reviewed top-level simple commands",
      mutate: (input) => wrapEvidenceCommand(input, repositoryGovernanceCommands[0], lines),
    })),
    // WIN-284 (+8). Every checkpoint this issue adds gets a control proving it
    // can go red. Four for the two coverage commands (removed, and hidden
    // inside a subshell where a naive scan would still "find" the text), and
    // four for the harness step and the conservation job.
    ...differentialCoverageCommands.flatMap((command) => [
      {
        name: `removed WIN-284 coverage gate ${command}`,
        expected: "V1 evidence script must contain only reviewed top-level simple commands",
        mutate: (input) => mutateFixture(input, "ci", command, `echo removed # ${command}`),
      },
      {
        name: `concealed WIN-284 coverage gate ${command}`,
        expected: "V1 evidence script must contain only reviewed top-level simple commands",
        mutate: (input) => wrapEvidenceCommand(input, command, ["(", command, ")"]),
      },
    ]),
    {
      name: "WIN-284 negative-control run cannot be deleted from CI",
      expected: "CI must contain exactly one WIN-284 differential harness step",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${expectedDifferentialHarnessStepName}`,
          "      - name: WIN-284 renamed away"
        ),
    },
    {
      name: "WIN-284 negative-control run cannot be made conditional",
      expected: "WIN-284 harness step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${expectedDifferentialHarnessStepName}`,
          `      - name: ${expectedDifferentialHarnessStepName}\n        if: false`
        ),
    },
    {
      name: "WIN-284 seeded-divergence catalogue cannot be dropped from its step",
      expected: "WIN-284 harness script must contain only the exact reviewed command sequence",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "          pnpm test:differential-harness:controls",
          "          echo skipped # pnpm test:differential-harness:controls"
        ),
    },
    {
      name: "WIN-284 twin-store conservation job cannot stop running the store gate",
      expected: "WIN-284 twin-store conservation job must run the store gate exactly once",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `        run: ${expectedDifferentialConservationCommand}`,
          "        run: echo skipped"
        ),
    },
    {
      name: "root package workspace graph cannot reappear",
      expected: "package.json must not declare workspaces; pnpm-workspace.yaml is authoritative",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          '"private": true,',
          '"private": true,\n  "workspaces": ["apps/*"],'
        ),
    },
    {
      name: "conditional V1 evidence step is unreachable",
      expected: "V1 evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "      - name: V1 M0 executable evidence gates\n        run:",
          "      - name: V1 M0 executable evidence gates\n        if: ${{ false }}\n        run:"
        ),
    },
    {
      name: "continue-on-error weakens V1 evidence step",
      expected: "V1 evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "      - name: V1 M0 executable evidence gates\n        run:",
          "      - name: V1 M0 executable evidence gates\n        continue-on-error: true\n        run:"
        ),
    },
    ...[...expectedV1PackageScripts].map(([name, target]) => ({
      name: `successful no-op V1 package script ${name}`,
      expected: `package.json must wire exact V1 script ${name}: ${target}`,
      mutate: (input) => mutateFixture(input, "packageJson", target, "node -p 0"),
    })),
    ...[...expectedRepositoryGovernanceScripts].map(([name, target]) => ({
      name: `successful no-op repository governance package script ${name}`,
      expected: `package.json must wire exact repository governance script ${name}: ${target}`,
      mutate: (input) => mutateFixture(input, "packageJson", target, "node -p 0"),
    })),
    ...[...expectedWorkspaceReachabilityScripts].map(([name, target]) => ({
      name: `successful no-op workspace reachability package script ${name}`,
      expected: `package.json must wire exact workspace reachability script ${name}: ${target}`,
      mutate: (input) => mutateFixture(input, "packageJson", target, "node -p 0"),
    })),
    ...[...expectedWin254Scripts].map(([name, target]) => ({
      name: `successful no-op WIN-254 package script ${name}`,
      expected: `package.json must wire exact WIN-254 script ${name}: ${target}`,
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          `"${name}": "${target}"`,
          `"${name}": "node -p 0"`,
        ),
    })),
    {
      name: "conditional WIN-254 evidence step is unreachable",
      expected: "WIN-254 evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${win254EvidenceStepName}\n        run:`,
          `      - name: ${win254EvidenceStepName}\n` + "        if: ${{ false }}\n        run:"
        ),
    },
    {
      name: "continue-on-error weakens WIN-254 evidence step",
      expected: "WIN-254 evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${win254EvidenceStepName}\n        run:`,
          `      - name: ${win254EvidenceStepName}\n        continue-on-error: true\n        run:`
        ),
    },
    {
      name: "conditional WIN-253 workspace reachability evidence step is unreachable",
      expected: "WIN-253 workspace reachability evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "      - name: WIN-253 workspace reachability evidence\n        run:",
          "      - name: WIN-253 workspace reachability evidence\n        if: ${{ false }}\n        run:"
        ),
    },
    {
      name: "continue-on-error weakens WIN-253 workspace reachability evidence step",
      expected: "WIN-253 workspace reachability evidence step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "      - name: WIN-253 workspace reachability evidence\n        run:",
          "      - name: WIN-253 workspace reachability evidence\n        continue-on-error: true\n        run:"
        ),
    },
    {
      name: "workflow shell default wraps WIN-253 workspace reachability evidence",
      expected:
        "WIN-253 workspace reachability step must not inherit workflow or job shell defaults",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "jobs:\n",
          "defaults:\n  run:\n    shell: bash {0} || true\n\njobs:\n"
        ),
    },
    {
      name: "job shell default wraps WIN-253 workspace reachability evidence",
      expected:
        "WIN-253 workspace reachability step must not inherit workflow or job shell defaults",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    defaults:\n      run:\n        shell: bash {0} || true\n    runs-on:"
        ),
    },
    {
      name: "conditional typecheck job bypasses WIN-253 workspace reachability evidence",
      expected: "WIN-253 workspace reachability job must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    if: ${{ false }}\n    runs-on:"
        ),
    },
    {
      name: "continue-on-error typecheck job weakens WIN-253 workspace reachability evidence",
      expected: "WIN-253 workspace reachability job must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    continue-on-error: true\n    runs-on:"
        ),
    },
    {
      name: "webapp pruned prepare target availability",
      expected: `apps/webapp/Dockerfile.platos must make ${prepareTarget} available in base before both shipping installs`,
      mutate: (input) =>
        mutateDockerfile(
          input,
          "apps/webapp/Dockerfile.platos",
          webappPrepareCopy,
          `# removed ${prepareTarget}`
        ),
    },
    {
      name: "root prepare target wiring",
      expected: `package.json prepare must execute ${prepareTarget}`,
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          `node ${prepareTarget}`,
          "node scripts/missing-hooks.mjs"
        ),
    },
    {
      name: "malformed .nvmrc",
      expected: ".nvmrc must pin exactly v22.14.0",
      mutate: (input) => mutateFixture(input, "nvmrc", "v22.14.0", "not-a-node-version"),
    },
    {
      name: "Node 20 .nvmrc",
      expected: ".nvmrc must pin exactly v22.14.0",
      mutate: (input) => mutateFixture(input, "nvmrc", "v22.14.0", "v20.20.0"),
    },
    {
      name: "wrong matrix candidate",
      expected: "build image matrix candidates must be unique and exact",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "image: platos-agent", "image: wrong-agent"),
    },
    {
      name: "duplicate matrix candidate",
      expected: "build image matrix name values must be unique",
      mutate: (input) => mutateFixture(input, "buildImages", "- name: migrations", "- name: agent"),
    },
    {
      name: "uncorrelated build action",
      expected: "build-push action file must correlate to matrix.dockerfile",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "file: ${{ matrix.dockerfile }}",
          "file: apps/agent/Dockerfile"
        ),
    },
    {
      name: "package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "      contents: read\n    strategy:",
          "      contents: read\n      packages: write\n    strategy:"
        ),
    },
    {
      name: "quoted package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "      contents: read\n    strategy:",
          '      contents: read\n      "packages": write\n    strategy:'
        ),
    },
    {
      name: "quoted root permissions and packages publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "jobs:\n",
          '"permissions":\n  "packages": write\n\njobs:\n'
        ),
    },
    {
      name: "root package write publication",
      expected: "build-images grants package write permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "jobs:\n",
          "permissions:\n  packages: write\n\njobs:\n"
        ),
    },
    {
      name: "root write-all publication",
      expected: "build-images grants write-all permission",
      mutate: (input) =>
        mutateFixture(input, "buildImages", "jobs:\n", '"permissions": "write-all"\n\njobs:\n'),
    },
    {
      name: "job write-all publication",
      expected: "build-images grants write-all permission",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "    permissions:\n      contents: read\n    strategy:",
          "    permissions: write-all\n    strategy:"
        ),
    },
    {
      name: "registry login publication",
      expected: "build-images contains a registry login action",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation registry login",
          uses: "docker/login-action@mutation",
        }),
    },
    {
      name: "build action push publication",
      expected: "build-push action must keep push false",
      mutate: (input) => mutateFixture(input, "buildImages", "push: false", "push: true"),
    },
    {
      name: "block registry exporter publication",
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          "outputs: |\n            type=registry"
        ),
    },
    {
      name: "block image exporter publication",
      expected: "build-push action contains a registry-capable exporter",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "outputs: type=oci,dest=${{ runner.temp }}/${{ matrix.name }}.oci.tar,oci-mediatypes=true",
          "outputs: |\n            type=image"
        ),
    },
    {
      name: "shell publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation redirected shell publication",
          run: "docker push>/var/tmp/mutation.log ghcr.io/example/image:mutation",
        }),
    },
    {
      name: "shell registry login",
      expected: "build-images contains an executable shell registry login",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation shell login",
          run: "docker login ghcr.io",
        }),
    },
    {
      name: "shell registry login with docker global options",
      expected: "build-images contains an executable shell registry login",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation global-option shell login",
          run: "docker --config /var/tmp/docker-config login ghcr.io",
        }),
    },
    {
      name: "bash command payload registry login",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation bash login payload",
          run: "bash -c 'docker login ghcr.io'",
        }),
    },
    {
      name: "bash command payload publication",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation bash publication payload",
          run: "bash -lc 'docker push ghcr.io/example/image:mutation'",
        }),
    },
    {
      name: "eval command payload publication",
      expected: "build-images contains executable shell command indirection",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation eval publication payload",
          run: "eval 'docker push ghcr.io/example/image:mutation'",
        }),
    },
    {
      name: "buildx push publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation buildx publication",
          run: "docker buildx build --push -t ghcr.io/example/image:mutation .",
        }),
    },
    {
      name: "buildx registry output publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation buildx registry exporter",
          run: "docker buildx build --output=type=registry -t ghcr.io/example/image:mutation .",
        }),
    },
    {
      name: "buildx imagetools create publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation buildx imagetools publication",
          run: "docker buildx imagetools create -t ghcr.io/example/image:mutation source/image:mutation",
        }),
    },
    {
      name: "compose push publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation compose publication",
          run: "docker compose push",
        }),
    },
    {
      name: "chained prefixed shell publication",
      expected: "build-images contains an executable shell publication command",
      mutate: (input) =>
        insertBuildCandidateStep(input, {
          name: "Mutation chained publication",
          run: "echo preparing && env TARGET=mutation docker push ghcr.io/example/image:mutation",
        }),
    },
    {
      name: "multiple installs in one RUN",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm install --frozen-lockfile --prod \u0026\u0026 pnpm install --no-frozen-lockfile"
        ),
    },
    {
      name: "frozen lockfile false",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "--frozen-lockfile --prod",
          "--frozen-lockfile=false --prod"
        ),
    },
    {
      name: "lowercase RUN enforcement",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "run pnpm install --frozen-lockfile --prod"
        ),
    },
    {
      name: "JSON RUN enforcement",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN ["pnpm", "install", "--frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "heredoc RUN fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN \u003c\u003cEOF\npnpm install --frozen-lockfile --prod\nEOF"
        ),
    },
    {
      name: "quoted hash pnpm install fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN echo "# pnpm install --frozen-lockfile --prod"'
        ),
    },
    {
      name: "pnpm global option install fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm --silent install --frozen-lockfile --prod"
        ),
    },
    {
      name: "pnpm install alias fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN pnpm i --no-frozen-lockfile --prod"
        ),
    },
    {
      name: "dynamic pnpm subcommand fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'ARG PNPM_COMMAND=install\nRUN pnpm "$PNPM_COMMAND" --frozen-lockfile --prod'
        ),
    },
    {
      name: "shell-form nested pnpm interpreter payload fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must not contain shell interpreter command payload RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          "RUN sh -c 'pnpm i --no-frozen-lockfile --prod'"
        ),
    },
    {
      name: "JSON nested pnpm interpreter payload fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must not contain shell interpreter command payload RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN ["sh", "-c", "pnpm i --no-frozen-lockfile --prod"]'
        ),
    },
    {
      name: "JSON env-wrapped pnpm install alias fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact frozen pnpm install RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["env", "pnpm", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "JSON corepack-wrapped versioned pnpm alias fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["corepack", "pnpm@10.23.0", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "JSON env split-string pnpm payload fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["env", "-S", "pnpm i --no-frozen-lockfile --prod"]'
        ),
    },
    {
      name: "JSON dynamic corepack command fails closed",
      expected:
        "internal-packages/tenancy-database/Dockerfile.migrations must contain only its exact executable pnpm/pnpx RUN instruction(s)",
      mutate: (input) =>
        mutateDockerfile(
          input,
          "internal-packages/tenancy-database/Dockerfile.migrations",
          "RUN pnpm install --frozen-lockfile --prod",
          'RUN pnpm install --frozen-lockfile --prod\nRUN ["corepack", "${PACKAGE_MANAGER}", "i", "--no-frozen-lockfile", "--prod"]'
        ),
    },
    {
      name: "webapp typecheck inert text",
      expected: "webapp typecheck must be one executable command scoped to the typecheck job",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "run: pnpm --filter webapp typecheck",
          "run: echo skipped # pnpm --filter webapp typecheck"
        ),
    },
    {
      name: "policy package wiring",
      expected: "package.json must wire the CI policy test executable",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          '"test:ci-policy": "node --test scripts/ci-policy.test.mjs"',
          '"test:ci-policy": "node --test scripts/ci-policy-disabled.test.mjs"'
        ),
    },
    {
      name: "Agent workload identity build ordering",
      expected: "package.json must build workload identity before the strict Agent shipping build",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          agentBuildScriptTarget,
          agentBuildScriptTarget.replace("pnpm --filter @internal/workload-identity build && ", "")
        ),
    },
    {
      name: "workload identity package test wiring",
      expected: "package.json must wire the workload identity shipping package test",
      mutate: (input) =>
        mutateFixture(input, "packageJson", workloadPackageTestTarget, "node -p 0"),
    },
    {
      name: "licence determinism test wiring",
      expected: "package.json must wire the deterministic licence generation test",
      mutate: (input) =>
        mutateFixture(input, "packageJson", licenseDeterminismTestTarget, "node -p 0"),
    },
    {
      name: "Agent runtime health smoke test wiring",
      expected: "package.json must wire the exact Agent runtime health smoke test",
      mutate: (input) =>
        mutateFixture(input, "packageJson", agentRuntimeSmokeTestTarget, "node -p 0"),
    },
    {
      name: "workload identity package test skipped in CI",
      expected: "CI must execute the workload identity shipping package test exactly once in typecheck",
      mutate: (input) =>
        mutateFixture(input, "ci", workloadPackageTestCommand, `echo skipped # ${workloadPackageTestCommand}`),
    },
    {
      name: "licence determinism test skipped in CI",
      expected: "CI must execute the deterministic licence generation test exactly once in typecheck",
      mutate: (input) =>
        mutateFixture(input, "ci", licenseDeterminismTestCommand, `echo skipped # ${licenseDeterminismTestCommand}`),
    },
    {
      name: "Agent runtime health smoke test skipped in CI",
      expected: "CI must execute the exact Agent runtime health smoke test exactly once in typecheck",
      mutate: (input) =>
        mutateFixture(input, "ci", agentRuntimeSmokeTestCommand, `echo skipped # ${agentRuntimeSmokeTestCommand}`),
    },
    {
      name: "Agent runtime image smoke skipped",
      expected:
        "persisted-state must run the exact Agent runtime package and health smoke after starting the candidate",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          "tests/persisted-state-gate/smoke-agent-runtime-image.sh",
          "echo skipped-agent-runtime-smoke"
        ),
    },
    {
      name: "exact YAML parser dependency",
      expected: "package.json must pin yaml 2.6.1 as an exact root devDependency",
      mutate: (input) => mutateFixture(input, "packageJson", '"yaml": "2.6.1"', '"yaml": "^2.6.1"'),
    },
    {
      name: "policy CI wiring inert text",
      expected: "typecheck job must execute the wired CI policy test exactly once",
      mutate: (input) =>
        mutateFixture(input, "ci", "pnpm test:ci-policy", "echo skipped # pnpm test:ci-policy"),
    },
    {
      name: "WIN-290 package suite selector",
      expected: "package.json must wire the exact focused WIN-290 suite",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          `"test:win-290": "${win290ScriptTarget}"`,
          '"test:win-290": "echo skipped"'
        ),
    },
    {
      name: "WIN-290 CI suite inert text",
      expected: "CI must execute the focused WIN-290 suite exactly once in typecheck",
      mutate: (input) =>
        mutateFixture(input, "ci", win290Command, `echo skipped # ${win290Command}`),
    },
    {
      name: "WIN-290 CI suite global uniqueness",
      expected: "CI must execute the focused WIN-290 suite exactly once in typecheck",
      mutate: (input) =>
        insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
          name: "Mutation duplicate WIN-290 suite",
          run: win290Command,
        }),
    },
    {
      name: "WIN-290 real Redis package selector",
      expected: "package.json must wire the exact WIN-290 real Redis DLQ lifecycle suite",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          `"test:win-290:redis": "${win290RedisScriptTarget}"`,
          '"test:win-290:redis": "pnpm --filter platos-agent exec vitest run src/monitoring/span-dlq.test.ts"'
        ),
    },
    {
      name: "WIN-290 real Redis package successful no-op",
      expected: "package.json must wire the exact WIN-290 real Redis DLQ lifecycle suite",
      mutate: (input) => mutateFixture(input, "packageJson", win290RedisScriptTarget, "node -p 0"),
    },
    {
      name: "WIN-290 real Redis CI suite skipped as inert text",
      expected:
        "CI must execute the WIN-290 real Redis DLQ lifecycle suite exactly once in typecheck",
      mutate: (input) =>
        mutateFixture(input, "ci", win290RedisCommand, `echo skipped # ${win290RedisCommand}`),
    },
    {
      name: "WIN-290 real Redis CI suite global uniqueness",
      expected:
        "CI must execute the WIN-290 real Redis DLQ lifecycle suite exactly once in typecheck",
      mutate: (input) =>
        insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
          name: "Mutation duplicate WIN-290 real Redis suite",
          run: win290RedisCommand,
        }),
    },
    {
      name: "WIN-290 real Redis inline success bypass",
      expected: "WIN-290 real Redis DLQ lifecycle step must execute only its exact command",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `run: ${win290RedisCommand}`,
          `run: ${win290RedisCommand} || true`
        ),
    },
    {
      name: "conditional WIN-290 real Redis step is unreachable",
      expected: "WIN-290 real Redis DLQ lifecycle step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${win290RedisStepName}\n        env:`,
          `      - name: ${win290RedisStepName}\n        if: \${{ false }}\n        env:`
        ),
    },
    {
      name: "continue-on-error weakens WIN-290 real Redis step",
      expected: "WIN-290 real Redis DLQ lifecycle step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `      - name: ${win290RedisStepName}\n        env:`,
          `      - name: ${win290RedisStepName}\n        continue-on-error: true\n        env:`
        ),
    },
    {
      name: "explicit shell bypass weakens WIN-290 real Redis step",
      expected: "WIN-290 real Redis DLQ lifecycle step must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `        run: ${win290RedisCommand}`,
          `        shell: bash {0} || true\n        run: ${win290RedisCommand}`
        ),
    },
    {
      name: "workflow shell default wraps WIN-290 real Redis step",
      expected:
        "WIN-290 real Redis DLQ lifecycle step must not inherit workflow or job shell defaults",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "jobs:\n",
          "defaults:\n  run:\n    shell: bash {0} || true\n\njobs:\n"
        ),
    },
    {
      name: "job shell default wraps WIN-290 real Redis step",
      expected:
        "WIN-290 real Redis DLQ lifecycle step must not inherit workflow or job shell defaults",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    defaults:\n      run:\n        shell: bash {0} || true\n    runs-on:"
        ),
    },
    {
      name: "conditional typecheck job bypasses WIN-290 real Redis step",
      expected: "WIN-290 real Redis DLQ lifecycle job must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    if: ${{ false }}\n    runs-on:"
        ),
    },
    {
      name: "continue-on-error typecheck job weakens WIN-290 real Redis step",
      expected: "WIN-290 real Redis DLQ lifecycle job must be unconditional and fail-fast",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          "  typecheck:\n    runs-on:",
          "  typecheck:\n    continue-on-error: true\n    runs-on:"
        ),
    },
    {
      name: "WIN-290 real Redis service URL",
      expected: "WIN-290 real Redis DLQ lifecycle step must set the exact Redis service URL",
      mutate: (input) =>
        mutateFixture(
          input,
          "ci",
          `PLATOS_TEST_REDIS_URL: ${win290RedisUrl}`,
          "PLATOS_TEST_REDIS_URL: redis://127.0.0.1:6380"
        ),
    },
    {
      name: "WIN-290 dedicated Redis major version",
      expected: "typecheck job must provide the exact dedicated Redis 7 service for WIN-290",
      mutate: (input) => mutateFixture(input, "ci", "image: redis:7", "image: redis:8"),
    },
    {
      name: "WIN-290 dedicated Redis health check",
      expected: "typecheck job must provide the exact dedicated Redis 7 service for WIN-290",
      mutate: (input) =>
        mutateFixture(input, "ci", '--health-cmd "redis-cli ping"', '--health-cmd "true"'),
    }
  );

  controls.push(
    {
      name: "persisted-state dependency install no-op",
      expected:
        "persisted-state install must be the exact unconditional fail-fast frozen lockfile command",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateInstallDependenciesStepName
          );
          assert.ok(step);
          step.run = "node -e 'process.exit(0)'";
        }),
    },
    {
      name: "conditional persisted-state dependency install",
      expected:
        "persisted-state install must be the exact unconditional fail-fast frozen lockfile command",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateInstallDependenciesStepName
          );
          assert.ok(step);
          step.if = "${{ false }}";
        }),
    },
    {
      name: "persisted-state dependency install or-true fail-open",
      expected:
        "persisted-state install must be the exact unconditional fail-fast frozen lockfile command",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateInstallDependenciesStepName
          );
          assert.ok(step);
          step.run = `${persistedStateInstallDependenciesCommand} || true`;
        }),
    },
    {
      name: "continue-on-error persisted-state dependency install",
      expected:
        "persisted-state install must be the exact unconditional fail-fast frozen lockfile command",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateInstallDependenciesStepName
          );
          assert.ok(step);
          step["continue-on-error"] = true;
        }),
    },
    {
      name: "shell override persisted-state dependency install",
      expected:
        "persisted-state install must be the exact unconditional fail-fast frozen lockfile command",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateInstallDependenciesStepName
          );
          assert.ok(step);
          step.shell = "bash {0} || true";
        }),
    },
    {
      name: "persisted-state dependency install reordered before setup-node",
      expected: "persisted-state exact dependency install must run after setup-node",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const installIndex = steps.findIndex(
            (step) => step.name === persistedStateInstallDependenciesStepName
          );
          assert.notEqual(installIndex, -1);
          const [installStep] = steps.splice(installIndex, 1);
          const setupIndex = steps.findIndex(
            (step) =>
              typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@")
          );
          assert.notEqual(setupIndex, -1);
          steps.splice(setupIndex, 0, installStep);
        }),
    },
    {
      name: "conditional persisted-state job",
      expected:
        "persisted-state job must be unconditional, fail-fast, and free of default-shell bypasses",
      mutate: (input) =>
        mutateWorkflowJob(input, "buildImages", "persisted-state", (job) => {
          job.if = "${{ false }}";
        }),
    },
    {
      name: "continue-on-error persisted-state job",
      expected:
        "persisted-state job must be unconditional, fail-fast, and free of default-shell bypasses",
      mutate: (input) =>
        mutateWorkflowJob(input, "buildImages", "persisted-state", (job) => {
          job["continue-on-error"] = true;
        }),
    },
    {
      name: "persisted-state job default-shell bypass",
      expected:
        "persisted-state job must be unconditional, fail-fast, and free of default-shell bypasses",
      mutate: (input) =>
        mutateWorkflowJob(input, "buildImages", "persisted-state", (job) => {
          job.defaults = { run: { shell: "bash {0} || true" } };
        }),
    },
    {
      name: "persisted-state compiled Webapp dependency step removed",
      expected:
        "build-images/persisted-state must contain exactly one accurate compiled Webapp dependency build step",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const index = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(index, -1);
          steps.splice(index, 1);
        }),
    },
    {
      name: "persisted-state workload-identity build removed",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          compiledAgentDependenciesCommand,
          "pnpm --filter @platos/tenancy-database build"
        ),
    },
    {
      name: "persisted-state compiled Webapp dependencies reordered before install",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          const [buildStep] = steps.splice(buildIndex, 1);
          const installIndex = steps.findIndex(
            (step) => step.name === persistedStateInstallDependenciesStepName
          );
          assert.notEqual(installIndex, -1);
          steps.splice(installIndex, 0, buildStep);
        }),
    },
    {
      name: "persisted-state compiled Webapp dependencies reordered after integration",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          const [buildStep] = steps.splice(buildIndex, 1);
          const integrationIndex = steps.findIndex(
            (step) => step.name === persistedStateIntegrationStepName
          );
          assert.notEqual(integrationIndex, -1);
          steps.splice(integrationIndex + 1, 0, buildStep);
        }),
    },
    {
      name: "new pre-build direct Webapp Vitest consumer",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex, 0, {
            name: "Mutation pre-build Webapp Vitest consumer",
            run: "pnpm --filter webapp exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "new pre-build equals-filter Webapp Vitest consumer",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex, 0, {
            name: "Mutation equals-filter pre-build Webapp consumer",
            run: "pnpm --filter=webapp exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "new pre-build short-filter Webapp Vitest consumer",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex, 0, {
            name: "Mutation short-filter pre-build Webapp consumer",
            run: "pnpm -F webapp exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "new pre-build working-directory Webapp Vitest consumer",
      expected:
        "build-images/persisted-state compiled Webapp dependencies must build after install and before every direct Webapp Vitest consumer",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex, 0, {
            name: "Mutation working-directory pre-build Webapp consumer",
            "working-directory": "apps/webapp",
            run: "pnpm exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "generic direct Webapp Vitest true-or suppression",
      expected:
        "build-images/persisted-state direct Webapp Vitest consumers must reject dead-code and control-flow suppression",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex + 1, 0, {
            name: "Mutation suppressed Webapp consumer",
            run: "true || pnpm --filter=webapp exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "generic direct Webapp Vitest exit-zero suppression",
      expected:
        "build-images/persisted-state direct Webapp Vitest consumers must reject dead-code and control-flow suppression",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex + 1, 0, {
            name: "Mutation dead-code Webapp consumer",
            run: "exit 0\npnpm -F webapp exec vitest run test/memoryPolicy.test.ts",
          });
        }),
    },
    {
      name: "generic direct Webapp Vitest source-alias argument",
      expected:
        "build-images/persisted-state direct Webapp Vitest consumers must reject source-alias arguments and config",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex + 1, 0, {
            name: "Mutation source-alias Webapp consumer",
            run: "pnpm --filter webapp exec vitest run test/memoryPolicy.test.ts --alias=@internal/workload-identity=../../internal-packages/workload-identity/src/index.ts",
          });
        }),
    },
    {
      name: "generic direct Webapp Vitest source-alias config",
      expected:
        "build-images/persisted-state direct Webapp Vitest consumers must reject source-alias arguments and config",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const buildIndex = steps.findIndex(
            (step) => step.name === compiledWebappDependenciesStepName
          );
          assert.notEqual(buildIndex, -1);
          steps.splice(buildIndex + 1, 0, {
            name: "Mutation source-config Webapp consumer",
            run: "pnpm --filter=webapp exec vitest run test/memoryPolicy.test.ts --config config/vitest-source-alias.ts",
          });
        }),
    },
    {
      name: "persisted-state workload-identity source-alias bypass",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          compiledAgentDependenciesCommand,
          "pnpm --filter @platos/tenancy-database build && echo '@internal/workload-identity=internal-packages/workload-identity/src/index.ts' > /var/tmp/webapp-source-alias"
        ),
    },
    {
      name: "persisted-state compiled Webapp dependency or-true bypass",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          compiledAgentDependenciesCommand,
          `${compiledAgentDependenciesCommand} || true`
        ),
    },
    {
      name: "persisted-state compiled Webapp dependency true-or bypass",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateFixture(
          input,
          "buildImages",
          compiledAgentDependenciesCommand,
          `true || ${compiledAgentDependenciesCommand}`
        ),
    },
    {
      name: "persisted-state compiled Webapp dependency exit-zero dead code",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === compiledWebappDependenciesStepName
          );
          assert.ok(step);
          step.run = `exit 0\n${compiledAgentDependenciesCommand}`;
        }),
    },
    {
      name: "conditional persisted-state compiled Webapp dependency step",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === compiledWebappDependenciesStepName
          );
          assert.ok(step);
          step.if = "${{ false }}";
        }),
    },
    {
      name: "continue-on-error persisted-state compiled Webapp dependency step",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === compiledWebappDependenciesStepName
          );
          assert.ok(step);
          step["continue-on-error"] = true;
        }),
    },
    {
      name: "shell override persisted-state compiled Webapp dependency step",
      expected:
        "build-images/persisted-state compiled Webapp dependency step must run exact tenancy and workload-identity builds without execution overrides",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === compiledWebappDependenciesStepName
          );
          assert.ok(step);
          step.shell = "bash {0} || true";
        }),
    },
    {
      name: "conditional persisted-state direct Webapp Vitest step",
      expected:
        "build-images/persisted-state direct Webapp Vitest steps must be unconditional and use reviewed fail-fast shells",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateIntegrationStepName
          );
          assert.ok(step);
          step.if = "${{ false }}";
        }),
    },
    {
      name: "continue-on-error persisted-state direct Webapp Vitest step",
      expected:
        "build-images/persisted-state direct Webapp Vitest steps must be unconditional and use reviewed fail-fast shells",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateIntegrationStepName
          );
          assert.ok(step);
          step["continue-on-error"] = true;
        }),
    },
    {
      name: "shell override persisted-state direct Webapp Vitest step",
      expected:
        "build-images/persisted-state direct Webapp Vitest steps must be unconditional and use reviewed fail-fast shells",
      mutate: (input) =>
        mutateWorkflowJobSteps(input, "buildImages", "persisted-state", (steps) => {
          const step = steps.find(
            (candidate) => candidate.name === persistedStateIntegrationStepName
          );
          assert.ok(step);
          step.shell = "bash {0} || true";
        }),
    },
    {
      name: "persisted-state integration no-op root alias",
      expected: "package.json must wire exact persisted-state integration alias",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          persistedStateIntegrationTarget,
          "node -e 'process.exit(0)'"
        ),
    },
    {
      name: "persisted-state integration different-test root alias",
      expected: "package.json must wire exact persisted-state integration alias",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          persistedStateIntegrationTarget,
          "pnpm --filter webapp exec vitest run test/memoryPolicy.test.ts"
        ),
    },
    {
      name: "persisted-state integration source-bypassing root alias",
      expected: "package.json must wire exact persisted-state integration alias",
      mutate: (input) =>
        mutateFixture(
          input,
          "packageJson",
          persistedStateIntegrationTarget,
          "pnpm --filter webapp exec vitest run --alias @internal/workload-identity=../../internal-packages/workload-identity/src/index.ts test/persistedStateGate.integration.test.ts"
        ),
    }
  );

  for (const command of relocatedCommands) {
    controls.push(
      {
        name: `relocated executable command ${command}`,
        expected: `typecheck job must execute relocated command: ${command}`,
        mutate: (input) => mutateFixture(input, "ci", command, `echo skipped # ${command}`),
      },
      {
        name: `relocated command absent from persisted-state ${command}`,
        expected: `persisted-state job must not execute relocated command: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(input, "buildImages", "persisted-state", {
            name: "Mutation slow-job command",
            run: command,
          }),
      },
      {
        name: `relocated command globally unique ${command}`,
        expected: `CI must execute relocated command exactly once across all jobs: ${command}`,
        mutate: (input) =>
          insertWorkflowJobStep(input, "ci", "cross-scope-isolation", {
            name: "Mutation decorated duplicate fast command",
            run: `${command} > /var/tmp/mutation.log`,
          }),
      }
    );
  }

  // M2 INTEGRATION DELTA — 340 (the M2 base) moves to 361. Six independent
  // contributions land on this count, on axes that do not interact, so the
  // pinned number is their SUM rather than any one side alone:
  //
  //   WIN-299 (M2.6), +2. The single new command
  //   (pnpm audit:advisory:nonvacuity) is declared in two selectors —
  //   v1ReleaseGateCommands and expectedV1EvidenceCommands — and the table
  //   derives one mutation control per declared command per selector.
  //
  //   WIN-284 (differential harness), +9, each attributable:
  //     +1  the fourth ci.yml setup-node, generated one control per occurrence
  //         by the expectedSetupNodeCounts loop, belonging to the new
  //         differential-state-conservation job.
  //     +4  two per coverage command (removed, concealed in a subshell) for
  //         `test:differential-coverage` and `audit:differential-coverage`.
  //     +4  the negative-control step deleted, made conditional, stripped of
  //         the seeded-divergence catalogue, and the twin-store job stopping
  //         running the store gate.
  //
  //   WIN-256 (domain contracts), +5. One fail-fast mutation control per new
  //   V1 release gate (audit/test:kernel-content, audit/test:sole-writer,
  //   test:v1-packages). Each asserts that appending `|| true` to that gate's
  //   command is detected.
  //
  //   WIN-297 (composition root), +2. audit/test:composition-root join the
  //   same V1 release gate list, so each gains the same `|| true` control.
  //
  //   WIN-258 (postgres tenancy repository), +1. The FIFTH ci.yml setup-node,
  //   which belongs to the new `postgres-tenancy-repository` job — the same
  //   shape as WIN-284's +1 above, and for the same reason: the controls are
  //   generated one per setup-node occurrence, so a job that pins its Node
  //   version gains a control that fails if the pin stops deriving from .nvmrc.
  //   The job itself adds no other control: its four run steps are ordinary
  //   pnpm commands with no `||`, no conditional and no relocated command.
  //
  //   WIN-260 (M2.5, typed configuration), +2. audit/test:env-access join the
  //   same V1 release gate list, so each gains the same `|| true` control. The
  //   same shape as WIN-297's +2 above, and for the same reason: a new release
  //   gate that could be neutralised by appending `|| true` is a gate that runs
  //   and cannot fail.
  //
  //   WIN-260 (M2.5, outbox/clock/retry), +2. audit/test:transaction-outcome
  //   join the same V1 release gate list, so each gains the same `|| true`
  //   control -- the same shape as the typed-configuration +2 immediately above,
  //   and for the same reason.
  //
  // 340 + 2 + 9 + 5 + 2 + 1 + 2 + 2 = 363. The count is pinned rather than
  // derived so that a control silently disappearing is a failure rather than a
  // smaller number nobody reads.
  assert.equal(
    controls.length,
    363,
    "semantic mutation control table must cover every declared checkpoint"
  );
  for (const control of controls) {
    await t.test(control.name, () => {
      const mutation = control.mutate(pristine);
      assert.notDeepEqual(mutation, pristine, "fixture mutation must change the fixture set");
      const violations = policyViolations(mutation);
      assert.ok(
        violations.some((violation) => violation.includes(control.expected)),
        `${control.name} mutation did not trip ${JSON.stringify(
          control.expected
        )}: ${violations.join("; ")}`
      );
    });
  }
});
