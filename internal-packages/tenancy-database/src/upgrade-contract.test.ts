import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

const packageRoot = resolve(__dirname, "..");
const prismaRoot = resolve(packageRoot, "prisma");
const schema = readFileSync(resolve(prismaRoot, "schema.prisma"), "utf8");
const integratedInitial = readFileSync(
  resolve(prismaRoot, "migrations/00000000000000_initial/migration.sql"),
  "utf8"
);
const originMainInitial = readFileSync(
  resolve(prismaRoot, "upgrade-baselines/origin-main/00000000000000_initial.sql"),
  "utf8"
);
const observabilityMigration = readFileSync(
  resolve(
    prismaRoot,
    "migrations/20260824010000_win144_observability_retry_vocabulary/migration.sql"
  ),
  "utf8"
);
const memoryMigration = readFileSync(
  resolve(
    prismaRoot,
    "migrations/20260824111500_memory_profile_key_and_source_contract/migration.sql"
  ),
  "utf8"
);
const m4UpgradeMigration = readFileSync(
  resolve(prismaRoot, "migrations/20260824233000_m4_forward_upgrade_contract/migration.sql"),
  "utf8"
);
const accessKeyUpgradeMigrationName = "20260825070000_access_key_revocation_fence";
const accessKeyUpgradeMigration = readFileSync(
  resolve(prismaRoot, `migrations/${accessKeyUpgradeMigrationName}/migration.sql`),
  "utf8"
);
const accessKeyRuntime = readFileSync(resolve(packageRoot, "src/access-key.ts"), "utf8");
const imageWorkflow = readFileSync(
  resolve(packageRoot, "../../.github/workflows/build-images.yml"),
  "utf8"
);
const publicationWorkflow = readFileSync(
  resolve(packageRoot, "../../.github/workflows/publish-images.yml"),
  "utf8"
);

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const createTableBlock = (sql: string, table: string): string =>
  sql.match(new RegExp(`CREATE TABLE "public"\\."${table}" \\([\\s\\S]*?\\n\\);`))?.[0] ?? "";

const persistedStateJobName = "persisted-state-completion";
const persistedStateJobKey = "persisted-state";
const rehearsalStepName = "Rehearse the ordered tenancy upgrade before evidence";
const evidenceStepName = "Measure the pristine dense fixture against the exact candidates";
const rehearsalRun = [
  "CI=true pnpm --filter @platos/tenancy-database exec vitest run \\",
  "  src/upgrade-contract.test.ts \\",
  "  src/upgrade-rehearsal.integration.test.ts \\",
  "  --reporter=verbose",
].join("\n") + "\n";
const evidenceRun = [
  "set -euo pipefail",
  "pnpm test:persisted-state:performance \\",
  "  2>&1 | tee artifacts/win235/performance.log",
  "pnpm test:persisted-state:performance-artifacts",
].join("\n") + "\n";

type WorkflowStep = Record<string, unknown>;
type WorkflowJob = Record<string, unknown>;
type WorkflowMutationContext = {
  workflow: Record<string, unknown>;
  job: WorkflowJob;
  steps: WorkflowStep[];
};

const parseBuildImagesWorkflow = (workflow: string): Record<string, unknown> => {
  const document = parseDocument(workflow, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`build-images workflow YAML is invalid: ${document.errors[0].message}`);
  }
  const parsed = document.toJS() as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("build-images workflow must contain a mapping");
  }
  return parsed as Record<string, unknown>;
};

const persistedStateSteps = (workflow: Record<string, unknown>): WorkflowStep[] => {
  const jobs = workflow.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error("build-images workflow jobs must contain a mapping");
  }
  const matchingJobs = Object.entries(jobs).filter(([, job]) =>
    job !== null && typeof job === "object" && !Array.isArray(job)
      ? (job as WorkflowJob).name === persistedStateJobName
      : false
  );
  expect(matchingJobs).toHaveLength(1);
  const [jobKey, job] = matchingJobs[0];
  expect(jobKey).toBe(persistedStateJobKey);
  const steps = (job as WorkflowJob).steps;
  if (!Array.isArray(steps) || steps.some((step) => step === null || typeof step !== "object" || Array.isArray(step))) {
    throw new Error("persisted-state workflow steps must contain mappings");
  }
  return steps as WorkflowStep[];
};

const defaultsRunShell = (owner: Record<string, unknown>, label: string): unknown => {
  const defaults = owner.defaults;
  if (defaults === undefined) return undefined;
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`${label} defaults must contain a mapping`);
  }
  const run = (defaults as Record<string, unknown>).run;
  if (run === undefined) return undefined;
  if (run === null || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`${label} defaults.run must contain a mapping`);
  }
  return (run as Record<string, unknown>).shell;
};

const assertUpgradeRehearsalPrecedesCandidateEvidence = (workflow: string): void => {
  const parsedWorkflow = parseBuildImagesWorkflow(workflow);
  const steps = persistedStateSteps(parsedWorkflow);
  const jobs = parsedWorkflow.jobs as Record<string, WorkflowJob>;
  const persistedStateJob = jobs[persistedStateJobKey];
  expect(persistedStateJob.if).toBeUndefined();
  expect(persistedStateJob["continue-on-error"]).toBeUndefined();
  expect(defaultsRunShell(parsedWorkflow, "workflow")).toBeUndefined();
  expect(defaultsRunShell(persistedStateJob, "persisted-state job")).toBeUndefined();
  const rehearsalSteps = steps.filter((step) => step.name === rehearsalStepName);
  const evidenceSteps = steps.filter((step) => step.name === evidenceStepName);
  expect(rehearsalSteps).toHaveLength(1);
  expect(evidenceSteps).toHaveLength(1);
  const rehearsalStep = rehearsalSteps[0];
  const evidenceStep = evidenceSteps[0];
  if (typeof rehearsalStep.run !== "string" || typeof evidenceStep.run !== "string") {
    throw new Error("rehearsal and evidence run commands must be executable scalar strings");
  }
  expect(rehearsalStep).toEqual({ name: rehearsalStepName, shell: "bash", run: rehearsalRun });
  expect(evidenceStep).toEqual({ name: evidenceStepName, shell: "bash", run: evidenceRun });
  expect(steps.indexOf(evidenceStep)).toBeGreaterThan(steps.indexOf(rehearsalStep));
};

const mutatePersistedStateContract = (
  workflowSource: string,
  mutate: (context: WorkflowMutationContext) => void
): string => {
  const document = parseDocument(workflowSource, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  const workflow = document.toJS() as Record<string, unknown>;
  const steps = persistedStateSteps(workflow);
  const jobs = workflow.jobs as Record<string, WorkflowJob>;
  mutate({ workflow, job: jobs[persistedStateJobKey], steps });
  document.contents = document.createNode(workflow);
  return String(document);
};

const mutatePersistedStateSteps = (
  workflowSource: string,
  mutate: (steps: WorkflowStep[]) => void
): string => mutatePersistedStateContract(workflowSource, ({ steps }) => mutate(steps));

describe("origin/main to integrated tenancy upgrade contract", () => {
  test("preserves every pre-existing migration byte and pins the exact origin/main rehearsal baseline", () => {
    expect(sha256(originMainInitial)).toBe(
      "5c43055e8b4d134676d7252ceba59bfe72d90b63c34be03e1807512b30ea19d3"
    );
    expect(sha256(integratedInitial)).toBe(
      "9c7deed5ff7d49248a972b1741e627bf00695060a11c8abfdcdc433fe9c48d5b"
    );
    expect(sha256(observabilityMigration)).toBe(
      "912c15b478d3e75cf425045ad0d045335064128b2b6ee3818fcfeecf5d445d9c"
    );
    expect(sha256(memoryMigration)).toBe(
      "297ec076b99701e557f363affb4e5318c8b6949590df81e50480360d459dde79"
    );
  });

  test("adds the AccessKey revocation fence only through the ordered migration set", () => {
    expect(createTableBlock(originMainInitial, "Environment")).not.toContain(
      '"accessKeyRevocationVersion"'
    );
    expect(createTableBlock(integratedInitial, "Environment")).not.toContain(
      '"accessKeyRevocationVersion"'
    );

    const addColumn = accessKeyUpgradeMigration.indexOf(
      'ADD COLUMN IF NOT EXISTS "accessKeyRevocationVersion" INTEGER'
    );
    const backfill = accessKeyUpgradeMigration.indexOf('SET "accessKeyRevocationVersion" = 0');
    const setDefault = accessKeyUpgradeMigration.indexOf(
      'ALTER COLUMN "accessKeyRevocationVersion" SET DEFAULT 0'
    );
    const setNotNull = accessKeyUpgradeMigration.indexOf(
      'ALTER COLUMN "accessKeyRevocationVersion" SET NOT NULL'
    );
    expect(addColumn).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(setDefault).toBeGreaterThan(backfill);
    expect(setNotNull).toBeGreaterThan(setDefault);
    expect(accessKeyUpgradeMigration).toContain('WHERE "accessKeyRevocationVersion" IS NULL');

    const orderedMigrations = readdirSync(resolve(prismaRoot, "migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(orderedMigrations.at(-1)).toBe("20260906120000_win258_thread_listing_index");
    expect(accessKeyRuntime).toContain("accessKeyRevocationVersion");
    assertUpgradeRehearsalPrecedesCandidateEvidence(imageWorkflow);
    expect(imageWorkflow).not.toContain("  publish-images:");
    expect(imageWorkflow).not.toContain("packages: write");
    expect(publicationWorkflow).toContain("workflow_dispatch:");
    expect(publicationWorkflow).toContain("environment: image-publication");
    expect(publicationWorkflow).toContain("packages: write");
    expect(publicationWorkflow).toContain('run-id: ${{ inputs.source_run_id }}');
  });

  test("fails closed when candidate-backed evidence is missing or reordered before rehearsal", () => {
    const evidenceIndex = (steps: WorkflowStep[]): number =>
      steps.findIndex((step) => step.name === evidenceStepName);
    const rehearsalIndex = (steps: WorkflowStep[]): number =>
      steps.findIndex((step) => step.name === rehearsalStepName);
    const mutations: Array<[string, (steps: WorkflowStep[]) => void]> = [
      [
        "comment-only performance decoy",
        (steps) => {
          const evidence = steps[evidenceIndex(steps)];
          evidence.run = evidenceRun.replace(
            "pnpm test:persisted-state:performance \\",
            "# pnpm test:persisted-state:performance \\"
          );
        },
      ],
      [
        "real evidence before rehearsal with a comment decoy after it",
        (steps) => {
          const [evidence] = steps.splice(evidenceIndex(steps), 1);
          steps.splice(rehearsalIndex(steps), 0, evidence);
          steps.splice(rehearsalIndex(steps) + 1, 0, {
            name: "Performance evidence comment decoy",
            run: "# pnpm test:persisted-state:performance \\\n",
          });
        },
      ],
      [
        "equivalent pnpm run substitution",
        (steps) => {
          const evidence = steps[evidenceIndex(steps)];
          evidence.run = evidenceRun.replace(
            "pnpm test:persisted-state:performance \\",
            "pnpm run test:persisted-state:performance \\"
          );
        },
      ],
      [
        "duplicate evidence step and name",
        (steps) => {
          const index = evidenceIndex(steps);
          steps.splice(index + 1, 0, structuredClone(steps[index]));
        },
      ],
      [
        "missing evidence run",
        (steps) => {
          delete steps[evidenceIndex(steps)].run;
        },
      ],
      [
        "non-scalar evidence run",
        (steps) => {
          steps[evidenceIndex(steps)].run = { command: "pnpm test:persisted-state:performance" };
        },
      ],
      [
        "reordered evidence",
        (steps) => {
          const [evidence] = steps.splice(evidenceIndex(steps), 1);
          steps.splice(rehearsalIndex(steps), 0, evidence);
        },
      ],
      [
        "missing evidence",
        (steps) => {
          steps.splice(evidenceIndex(steps), 1);
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      expect(
        () => assertUpgradeRehearsalPrecedesCandidateEvidence(
          mutatePersistedStateSteps(imageWorkflow, mutate)
        ),
        label
      ).toThrow();
    }

    const executionControlMutations: Array<
      [string, (context: WorkflowMutationContext) => void]
    > = [
      [
        "conditional persisted-state job",
        ({ job }) => {
          job.if = "${{ false }}";
        },
      ],
      [
        "continue-on-error persisted-state job",
        ({ job }) => {
          job["continue-on-error"] = true;
        },
      ],
      [
        "workflow default shell",
        ({ workflow }) => {
          workflow.defaults = { run: { shell: "bash {0} || true" } };
        },
      ],
      [
        "persisted-state job default shell",
        ({ job }) => {
          job.defaults = { run: { shell: "bash {0} || true" } };
        },
      ],
      [
        "rehearsal step shell drift",
        ({ steps }) => {
          steps[rehearsalIndex(steps)].shell = "sh";
        },
      ],
    ];
    for (const [label, mutate] of executionControlMutations) {
      expect(
        () => assertUpgradeRehearsalPrecedesCandidateEvidence(
          mutatePersistedStateContract(imageWorkflow, mutate)
        ),
        label
      ).toThrow();
    }

    const duplicateRunKey = imageWorkflow.replace(
      `      - name: ${evidenceStepName}\n        shell: bash\n        run: |`,
      `      - name: ${evidenceStepName}\n        shell: bash\n        run: echo duplicate\n        run: |`
    );
    expect(duplicateRunKey).not.toBe(imageWorkflow);
    expect(() => assertUpgradeRehearsalPrecedesCandidateEvidence(duplicateRunKey)).toThrow();
  });

  test("covers every physical initial-migration addition absent from origin/main", () => {
    const coverage = {
      PostmanExecution: [
        'CREATE TABLE IF NOT EXISTS "public"."PostmanExecution"',
        '"PostmanExecution_contextHandle_key"',
        '"PostmanExecution_turnId_key"',
        '"PostmanExecution_templateId_requestId_key"',
        '"PostmanExecution_environmentId_createdAt_idx"',
        '"PostmanExecution_actorUserId_createdAt_idx"',
        '"PostmanExecution_threadId_idx"',
        "PostmanExecution_environmentId_fkey",
        "PostmanExecution_agentId_fkey",
        "PostmanExecution_templateId_fkey",
        "PostmanExecution_actorUserId_fkey",
        "PostmanExecution_simulatedEndUserId_fkey",
        "PostmanExecution_threadId_fkey",
        "PostmanExecution_turnId_fkey",
        "PostmanExecution_requestFingerprint_check",
        "PostmanExecution_contextHandle_check",
        "PostmanExecution_ancestry",
        "PostmanExecution_attribution_immutable",
      ],
      ThreadFork: [
        'ADD COLUMN IF NOT EXISTS "forkedUpToTurnId" UUID',
        'ADD COLUMN IF NOT EXISTS "forkedTurnIds" UUID[]',
        '"Thread_forkedUpToTurnId_idx"',
        "Thread_forkedUpToTurnId_fkey",
        'cardinality(NEW."forkedTurnIds")',
        "Thread_owner_immutable",
        "Thread_ancestry",
      ],
      MessageAttachmentOwnership: [
        'ADD COLUMN IF NOT EXISTS "agentId" UUID',
        'ADD COLUMN IF NOT EXISTS "threadId" UUID',
        "MessageAttachment ownership backfill failed",
        'ALTER COLUMN "agentId" SET NOT NULL',
        'ALTER COLUMN "threadId" SET NOT NULL',
        "MessageAttachment_agentId_threadId_createdAt_idx",
        "MessageAttachment_threadId_turnId_idx",
        "MessageAttachment_agentId_fkey",
        "MessageAttachment_threadId_fkey",
        "MessageAttachment_owner_immutable",
        "MessageAttachment_binding_one_way",
        "MessageAttachment_ancestry",
      ],
      EntityToolPolicyOwnership: [
        'ADD COLUMN IF NOT EXISTS "environmentId" UUID',
        "EntityToolPolicy ownership backfill failed",
        "count(DISTINCT environment.id)",
        "EntityToolPolicy_environmentId_entityId_toolId_key",
        'DROP INDEX IF EXISTS "public"."EntityToolPolicy_entityId_toolId_key"',
        "EntityToolPolicy_environmentId_fkey",
        "EntityToolPolicy_ancestry",
      ],
    } as const;

    for (const [area, fragments] of Object.entries(coverage)) {
      for (const fragment of fragments) {
        expect(m4UpgradeMigration, `${area}: ${fragment}`).toContain(fragment);
      }
    }

    expect(createTableBlock(originMainInitial, "PostmanExecution")).toBe("");
    expect(createTableBlock(integratedInitial, "PostmanExecution")).not.toBe("");
    for (const addition of ['"forkedUpToTurnId" UUID', '"forkedTurnIds" UUID[]']) {
      expect(createTableBlock(originMainInitial, "Thread"), addition).not.toContain(addition);
      expect(createTableBlock(integratedInitial, "Thread"), addition).toContain(addition);
    }
    for (const addition of ['"agentId" UUID NOT NULL', '"threadId" UUID NOT NULL']) {
      expect(createTableBlock(originMainInitial, "MessageAttachment"), addition).not.toContain(
        addition
      );
      expect(createTableBlock(integratedInitial, "MessageAttachment"), addition).toContain(
        addition
      );
    }
    expect(createTableBlock(originMainInitial, "EntityToolPolicy")).not.toContain(
      '"environmentId" UUID NOT NULL'
    );
    expect(createTableBlock(integratedInitial, "EntityToolPolicy")).toContain(
      '"environmentId" UUID NOT NULL'
    );
  });

  test("accounts for schema deltas that intentionally require no additional storage DDL", () => {
    const storagePreservingMappings = [
      'requestCount   Int                 @default(1) @map("attempts")',
      'tokenRefreshClaimId    String?   @map("tokenRefreshAttemptId")',
      'retryCount       Int       @default(0) @map("attempts")',
      'retryCount             Int                 @default(0) @map("attemptCount")',
      'lastRetryAt            DateTime?           @map("lastAttemptAt")',
      'retryNumber    Int                 @map("attemptNumber")',
      '@@map("AlertDeliveryAttempt")',
      'invocationType   String     @map("triggerType")',
      'nextRetryAt       DateTime?  @map("nextAttemptAt")',
    ];
    for (const mapping of storagePreservingMappings) expect(schema).toContain(mapping);

    expect(observabilityMigration).toContain('RENAME COLUMN "attempts" TO "retryCount"');
    for (const memoryColumn of [
      'ADD COLUMN "profileKey" TEXT',
      'ADD COLUMN "originalSource" TEXT',
      'ADD COLUMN "originalSourceThreadId" TEXT',
      'ADD COLUMN "originalSourceTurnIds" TEXT[]',
    ]) {
      expect(memoryMigration).toContain(memoryColumn);
    }
  });

  test("runs fail-loud compatible preflights before atomic tenant-derived backfills", () => {
    expect(m4UpgradeMigration).toContain("every application\n-- writer must be stopped");
    const transaction = m4UpgradeMigration.indexOf("\nBEGIN;\n");
    const attachmentPreflight = m4UpgradeMigration.indexOf(
      "MessageAttachment ownership backfill failed"
    );
    const attachmentBackfill = m4UpgradeMigration.indexOf(
      'UPDATE "public"."MessageAttachment" attachment'
    );
    const attachmentNotNull = m4UpgradeMigration.indexOf(
      'ALTER TABLE "public"."MessageAttachment" ALTER COLUMN "agentId" SET NOT NULL'
    );
    expect(attachmentPreflight).toBeGreaterThanOrEqual(0);
    expect(attachmentPreflight).toBeLessThan(transaction);
    expect(attachmentBackfill).toBeGreaterThan(attachmentPreflight);
    expect(attachmentBackfill).toBeGreaterThan(transaction);
    expect(attachmentNotNull).toBeGreaterThan(attachmentBackfill);
    expect(m4UpgradeMigration).toContain("unattached_count");
    expect(m4UpgradeMigration).toContain("scope_mismatch_count");
    expect(m4UpgradeMigration).toContain("conflicting_owner_count");

    const policyPreflight = m4UpgradeMigration.indexOf(
      "EntityToolPolicy ownership backfill failed"
    );
    const policyBackfill = m4UpgradeMigration.indexOf("WITH owners AS");
    const policyNotNull = m4UpgradeMigration.indexOf(
      'ALTER TABLE "public"."EntityToolPolicy" ALTER COLUMN "environmentId" SET NOT NULL'
    );
    expect(policyPreflight).toBeGreaterThanOrEqual(0);
    expect(policyPreflight).toBeLessThan(transaction);
    expect(policyBackfill).toBeGreaterThan(policyPreflight);
    expect(policyBackfill).toBeGreaterThan(transaction);
    expect(policyNotNull).toBeGreaterThan(policyBackfill);
    expect(m4UpgradeMigration).toContain("missing_owner_count");
    expect(m4UpgradeMigration).toContain("ambiguous_owner_count");
    expect(m4UpgradeMigration).toContain("information_schema.columns");
    expect(m4UpgradeMigration).toContain("NULL::UUID");
    expect(m4UpgradeMigration.match(/MessageAttachment ownership backfill failed/g)).toHaveLength(
      1
    );
    expect(m4UpgradeMigration.match(/EntityToolPolicy ownership backfill failed/g)).toHaveLength(1);
    expect(m4UpgradeMigration).not.toMatch(/LIMIT\s+1/i);
  });
});
