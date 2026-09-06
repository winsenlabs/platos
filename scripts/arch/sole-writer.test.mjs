import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  BLANKET_OWNER,
  CANONICAL_STORE_ADAPTERS,
  MUTATING_DELEGATE_METHODS,
  OWNER,
  RAW_SQL_METHODS,
  READ_DELEGATE_METHODS,
  UNOWNED_ADR_ROWS,
  delegateName,
  modelForDelegate,
  owners,
} from "./table-ownership.mjs";
import {
  canonicalTables,
  check,
  checkMapIntegrity,
  checkWriteEnforcement,
  failures,
  findSqlMutations,
  findWrites,
  owningPackage,
  ownerDirectories,
  ownerDirectory,
  readSchemaModels,
  readSchemaTables,
} from "./sole-writer.mjs";

const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files) {
  const root = mkdtempSync("/var/tmp/platos-sole-writer-");
  fixtures.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Map integrity — live against the real schema.
// ---------------------------------------------------------------------------

test("every canonical row in the live schema has exactly one owner", () => {
  const result = checkMapIntegrity();
  assert.deepEqual(result.problems, []);
  assert.equal(result.schemaModelCount, result.mappedModelCount);
  assert.ok(result.schemaModelCount >= 93, `scan looks vacuous: ${result.schemaModelCount} model(s)`);
});

test("the map's scan is not vacuous — it reads the real schema", () => {
  const models = readSchemaModels();
  assert.ok(models.includes("User"));
  assert.ok(models.includes("Organization"));
  assert.ok(models.includes("ToolCall"));
  assert.equal(new Set(models).size, models.length, "schema declares no duplicate model");
});

test("every owner is a real context directory, and the outbox pseudo-owner is an adapter", () => {
  assert.equal(ownerDirectory("tenancy"), "packages/contexts/tenancy");
  assert.equal(ownerDirectory("<kernel-outbox-adapter>"), "packages/adapters/outbox");
  // 17 ADR contexts + the outbox adapter pseudo-owner.
  assert.equal(owners().length, 18);
});

test("the ADR rows that are not canonical rows are recorded, not silently dropped", () => {
  assert.deepEqual(Object.keys(UNOWNED_ADR_ROWS).sort(), [
    "PlatformNotification",
    "PlatformNotificationInteraction",
    "SecretReference",
  ]);
  const schema = new Set(readSchemaModels());
  for (const model of Object.keys(UNOWNED_ADR_ROWS)) {
    assert.ok(!schema.has(model), `${model} is recorded as absent but is in the schema`);
    assert.ok(!(model in OWNER), `${model} is recorded as absent but has an owner`);
  }
});

test("ADR decisions that placed a contested row are pinned, so a silent flip fails", () => {
  // §7 decision 4: the EXECUTOR owns the execution record, not the transcript.
  assert.equal(OWNER.ToolCall, "tools");
  assert.equal(OWNER.ToolCallAudit, "tools");
  assert.equal(OWNER.Step, "conversations");
  // §7 decision 5: loadout is authoring.
  assert.equal(OWNER.AgentSkill, "agents");
  // §7 decision 6: Entity is the structural tenant row, not a channel record.
  assert.equal(OWNER.Entity, "tenancy");
  // §3: the auth wrong-way edge lands with governance as SafetyEvent's sole writer.
  assert.equal(OWNER.SafetyEvent, "governance");
  // §1 closing note + §7 decision 8: one physical outbox.
  assert.equal(OWNER.Event, "<kernel-outbox-adapter>");
  assert.equal(OWNER.ObservabilityOutbox, "<kernel-outbox-adapter>");
  // WIN-296's post-ADR row.
  assert.equal(OWNER.AccessKeyBootstrapGrant, "identity-access");
});

test("the vendor schema is owned wholesale by the durable-runtime adapter (§7 decision 10)", () => {
  assert.equal(BLANKET_OWNER.owner, "packages/adapters/durable-runtime");
  assert.match(BLANKET_OWNER.schema, /internal-packages\/database/u);
});

// ---------------------------------------------------------------------------
// Write enforcement — proven by fixtures, because no V1 package writes yet.
// ---------------------------------------------------------------------------

const write = (delegate, method) => `export async function run(db: any) {\n  await db.${delegate}.${method}({});\n}\n`;

test("a package writing a row it does not own FAILS", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/rogue.ts": write("user", "create"),
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, "User");
  assert.equal(result.violations[0].expected, "packages/contexts/identity-access");
  assert.match(result.violations[0].message, /identity-access is its sole writer/u);
});

test("the SAME write from the owning package PASSES", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/mint.ts": write("user", "create"),
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 1, "the write must be seen, not merely un-flagged");
});

test("every mutating method is enforced, and reads are exempt by design", () => {
  for (const method of MUTATING_DELEGATE_METHODS) {
    const root = fixture({ [`packages/contexts/files/application/x.ts`]: write("user", method) });
    assert.equal(checkWriteEnforcement(root).violations.length, 1, `${method} must be enforced`);
  }
  for (const method of ["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"]) {
    const root = fixture({ [`packages/contexts/files/application/x.ts`]: write("user", method) });
    assert.deepEqual(checkWriteEnforcement(root).violations, [], `${method} is a read and must be exempt`);
  }
});

// ---------------------------------------------------------------------------
// WIN-258 T2 (ADR M0.3 §15). `postgres-tenancy` is now the canonical-store
// delegate of TWO owners, and these are the refusals that widening did not take
// with it. The delegation is granted PER OWNER, by hand, and grants exactly the
// rows that owner owns.
// ---------------------------------------------------------------------------

test("§15: the shared directory may write BOTH owners' rows and NOTHING else", () => {
  const permitted = fixture({
    "packages/adapters/postgres-tenancy/src/a.ts": write("user", "create"),
    "packages/adapters/postgres-tenancy/src/b.ts": write("organization", "create"),
  });
  const result = checkWriteEnforcement(permitted);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 2, "both writes must be SEEN, not merely un-flagged");

  // A third owner's row from the same directory is still refused. "Many owners
  // per directory" is not "any row from that directory".
  //
  // WIN-258 T5 moved this example from `Memory` to `Artifact` and then, when
  // `files` became the THIRTEENTH delegated owner, from `Artifact` to `Job`.
  // Each move is the case defending itself: a delegated row would make it go
  // green while asserting nothing. `jobs` owns `Job` and has no entry in
  // `CANONICAL_STORE_ADAPTERS`, which is the property this case is about.
  const refused = fixture({
    "packages/adapters/postgres-tenancy/src/c.ts": write("job", "deleteMany"),
  });
  const violations = checkWriteEnforcement(refused).violations;
  assert.equal(violations.length, 1);
  assert.equal(violations[0].model, "Job");
  assert.match(violations[0].message, /jobs is its sole writer/u);
});

test("WIN-258 T5: an `agents` row written from any OTHER directory FAILS", () => {
  // The refusal the delegation has to keep. Each of the seven rows is written
  // from a directory that is neither `packages/contexts/agents` nor the adapter,
  // and each must be reported — a permission nothing refuses is not a permission.
  for (const delegate of [
    "agent",
    "agentBinding",
    "agentCluster",
    "agentSkill",
    "agentVersion",
    "macro",
    "postmanTemplate",
  ]) {
    const root = fixture({
      "packages/contexts/tools/application/rogue.ts": write(delegate, "create"),
    });
    const violations = checkWriteEnforcement(root).violations;
    assert.equal(violations.length, 1, `${delegate} must be refused from tools`);
    assert.equal(violations[0].expected, "packages/contexts/agents");
    assert.match(violations[0].message, /agents is its sole writer/u);
  }

  // From the adapter it is permitted, and the write is SEEN rather than merely
  // un-flagged.
  const permitted = fixture({
    "packages/adapters/postgres-tenancy/src/agents-x.ts": write("agent", "create"),
  });
  const allowed = checkWriteEnforcement(permitted);
  assert.deepEqual(allowed.violations, []);
  assert.equal(allowed.writeCount, 1);

  // And the widening did not licence the directory over rows `agents` does not
  // own: `Memory` is `memory`'s, and is refused from here however the write is
  // spelled.
  //
  // WIN-258 T5 MOVED THIS EXAMPLE, and the move is itself the finding.
  // `EnvironmentSkill` used to stand here, because `skills` had no entry in
  // `CANONICAL_STORE_ADAPTERS` and this directory therefore could not write it.
  // It now does, and it resolves to the SAME directory — so a write to
  // `EnvironmentSkill` from a file named `agents-y.ts` is legal, because the
  // gate judges the DIRECTORY and both owners resolve to this one. That is the
  // exact consequence Amendment 15 chose and it is stated rather than papered
  // over: what still holds is that ownership is carried by the TAG on the row,
  // so a row NO owner has delegated here is still refused, and a write from any
  // third directory is still refused. `Job` is the witness for the first and the
  // case below is the witness for the second — it was `Artifact` until `files`
  // was delegated, and the substitution is the case keeping its meaning rather
  // than a repair.
  const refused = fixture({
    "packages/adapters/postgres-tenancy/src/agents-y.ts": write("job", "create"),
  });
  const violations = checkWriteEnforcement(refused).violations;
  assert.equal(violations.length, 1);
  assert.equal(violations[0].model, "Job");
  assert.equal(violations[0].expected, "packages/contexts/jobs");
});

// ---------------------------------------------------------------------------
// WIN-258 T5 — `skills`, the NINTH owner delegated to the one adapter directory.
// ---------------------------------------------------------------------------

test("§15: skills' three rows are writable from the delegate and from NOWHERE else", () => {
  // The permission, first. Without this the refusals below would pass against a
  // gate that refused everything.
  for (const delegate of ["skill", "projectSkill", "environmentSkill"]) {
    const permitted = fixture({
      [`packages/adapters/postgres-tenancy/src/skills-${delegate}.ts`]: write(delegate, "upsert"),
    });
    const allowed = checkWriteEnforcement(permitted);
    assert.deepEqual(allowed.violations, [], `${delegate} must be permitted from the delegate`);
    assert.equal(allowed.writeCount, 1);
  }

  // THE REFUSAL, from every OTHER kind of directory a write could come from: a
  // peer context, a peer adapter, and the outbox adapter — which is delegated
  // here for `Event` and is delegated for nothing else.
  const elsewhere = [
    "packages/contexts/memory/application/rogue.ts",
    "packages/contexts/agents/application/rogue.ts",
    "packages/adapters/redis-cache/src/rogue.ts",
    "packages/adapters/outbox/src/rogue.ts",
  ];
  for (const model of ["skill", "projectSkill", "environmentSkill"]) {
    for (const path of elsewhere) {
      const trespass = checkWriteEnforcement(fixture({ [path]: write(model, "create") }));
      assert.equal(
        trespass.violations.length,
        1,
        `a write to ${model} from ${path} must be refused`,
      );
      assert.equal(trespass.violations[0].expected, "packages/contexts/skills");
      assert.deepEqual(trespass.violations[0].permitted, [
        "packages/contexts/skills",
        "packages/adapters/postgres-tenancy",
      ]);
      assert.match(trespass.violations[0].message, /skills is its sole writer/u);
    }
  }

  // And raw SQL naming the table is judged the same way as a delegate call, from
  // the same foreign directories — which is the door six of the seven 2026-09-02
  // probes went through.
  const raw = 'export async function run(db: any) {\n  await db.$executeRawUnsafe(\'INSERT INTO "Skill" (id) VALUES (1)\');\n}\n';
  const rawTrespass = checkWriteEnforcement(
    fixture({ "packages/contexts/memory/application/rogue.ts": raw }),
  );
  assert.equal(rawTrespass.violations.length, 1);
  assert.equal(rawTrespass.violations[0].model, "Skill");
  assert.equal(rawTrespass.violations[0].expected, "packages/contexts/skills");
});

test("§15: the delegation is per OWNER, not per adapter that happens to serve one", () => {
  // `redis-ratelimit` is also owned by identity-access (it implements that
  // context's `RateLimiter`). It is not a canonical store and may not write a
  // row — which is why `CANONICAL_STORE_ADAPTERS` is written by hand rather than
  // derived from the adapter table's owner column.
  const root = fixture({
    "packages/adapters/redis-ratelimit/src/x.ts": write("user", "create"),
  });
  const violations = checkWriteEnforcement(root).violations;
  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, "packages/contexts/identity-access");
});

test("§15: ownerDirectories grants exactly two directories, and only where declared", () => {
  // The rule the two cases above rest on, stated directly. An owner with no
  // entry has exactly ONE permitted directory — the context — which is the
  // property that keeps the shared directory from becoming a blanket licence.
  assert.deepEqual(ownerDirectories("tenancy"), [
    "packages/contexts/tenancy",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("identity-access"), [
    "packages/contexts/identity-access",
    "packages/adapters/postgres-tenancy",
  ]);
  // WIN-258 T5. `cost-monitoring` moved from the undelegated list below to this
  // one; the list it left still has to contain somebody, or the case stops
  // saying anything.
  assert.deepEqual(ownerDirectories("cost-monitoring"), [
    "packages/contexts/cost-monitoring",
    "packages/adapters/postgres-tenancy",
  ]);
  // WIN-258 T5. `channels`, `governance` and `secrets` all moved from the
  // undelegated list below to this one — the SIXTH, SEVENTH and EIGHTH contexts
  // to do so; the list they left still has to contain somebody, or the case
  // stops saying anything.
  assert.deepEqual(ownerDirectories("channels"), [
    "packages/contexts/channels",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("governance"), [
    "packages/contexts/governance",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("secrets"), [
    "packages/contexts/secrets",
    "packages/adapters/postgres-tenancy",
  ]);
  // WIN-258 T5. `conversations` is the TENTH, and it is the one the list it left
  // most needed to lose: `Thread` and `Turn` are the rows the OTHER eight
  // owners' harnesses seed by hand precisely because this owner had no entry.
  assert.deepEqual(ownerDirectories("conversations"), [
    "packages/contexts/conversations",
    "packages/adapters/postgres-tenancy",
  ]);
  // And `memory` is the TWELFTH and `files` the THIRTEENTH, which took the last
  // of this case's old undelegated examples with them. The list below still has
  // to contain somebody or the case stops saying anything, so it names two
  // contexts this wave does NOT reach: `jobs`, whose `AgentApproval` hangs off a
  // `Thread` this directory now writes, and `privacy`, which erases THROUGH
  // other contexts' ports rather than owning a store here.
  assert.deepEqual(ownerDirectories("memory"), [
    "packages/contexts/memory",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("files"), [
    "packages/contexts/files",
    "packages/adapters/postgres-tenancy",
  ]);
  for (const owner of ["jobs", "privacy"]) {
    assert.deepEqual(ownerDirectories(owner), [`packages/contexts/${owner}`]);
  }
});

test("the outbox adapter is the only package that may write Event", () => {
  const bad = fixture({ "packages/contexts/observability/application/x.ts": write("event", "create") });
  assert.equal(checkWriteEnforcement(bad).violations.length, 1);

  const good = fixture({ "packages/adapters/outbox/src/x.ts": write("event", "create") });
  assert.deepEqual(checkWriteEnforcement(good).violations, []);
});

test("only cost-monitoring's own two directories may write its six rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the six rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise
  // sit here unnoticed behind a green case for `Budget`.
  const SIX = [
    ["budget", "Budget"],
    ["budgetThresholdEvent", "BudgetThresholdEvent"],
    ["alertChannel", "AlertChannel"],
    ["alertChannelConfiguration", "AlertChannelConfiguration"],
    ["alertDelivery", "AlertDelivery"],
    ["alertDeliveryRetry", "AlertDeliveryRetry"],
  ];

  for (const [delegate, model] of SIX) {
    // The delegate directory: legal, and the reason the repositories can exist.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({
          [`packages/contexts/cost-monitoring/application/x.ts`]: write(delegate, "create"),
        }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `observability` is the pointed choice — it is
    // the context that reads cost data and would most plausibly write a
    // threshold event, and it is exactly as refused as anything else.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/observability/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/observability");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/cost-monitoring",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/outbox/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }
});

test("only channels' own two directories may write its six rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the six rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `ChannelConnection`.
  const SIX = [
    ["channelApp", "ChannelApp"],
    ["channelAppThread", "ChannelAppThread"],
    ["channelConnection", "ChannelConnection"],
    ["channelEventInbox", "ChannelEventInbox"],
    ["channelInstallation", "ChannelInstallation"],
    ["channelThread", "ChannelThread"],
  ];

  for (const [delegate, model] of SIX) {
    // The delegate directory: legal, and the reason the repository can exist.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/channels/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `conversations` is the pointed choice — it owns
    // `Thread`, which every link row points at, and would most plausibly write a
    // link while cleaning one up. It is exactly as refused as anything else.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/conversations/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/conversations");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/channels",
      "packages/adapters/postgres-tenancy",
    ]);
    // And the vendor-client adapter this context DOES own is not a loophole:
    // `packages/adapters/channel-slack` is `channels`' adapter and holds the
    // provider SDK, and being that adapter is not the qualification — being this
    // owner's declared canonical STORE is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/channel-slack/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from the context's own vendor adapter`,
    );
  }
});

test("only governance's own two directories may write its five rows", () => {
  // WIN-258 T5. The delegation added for `governance` is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the five rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `SafetyEvent`.
  const FIVE = [
    ["safetyEvent", "SafetyEvent"],
    ["messageRating", "MessageRating"],
    ["evalCriterion", "EvalCriterion"],
    ["agentEval", "AgentEval"],
    ["goldenSet", "GoldenSet"],
  ];

  for (const [delegate, model] of FIVE) {
    // The delegate directory: legal, and the reason the five repositories can
    // exist at all.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/governance/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `conversations` is the pointed choice — it owns
    // the `Thread` and the `Turn` that three of these five rows hang off, it
    // cascades them away when a thread is deleted, and it is exactly as refused
    // from writing one as anything else is.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/conversations/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/conversations");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/governance",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/outbox/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // AND RAW SQL IS NOT A WAY ROUND IT. The gate attributes a raw statement to
  // the table its SQL names, so a context reaching for the ledger through
  // `$executeRaw` is refused on the same terms as one reaching for the delegate.
  const raw = checkWriteEnforcement(
    fixture({
      "packages/contexts/observability/application/steal.ts":
        `export async function run(db) {\n` +
        `  await db.$executeRaw\`insert into "public"."SafetyEvent" (id) values ('x')\`;\n` +
        `}\n`,
    }),
  );
  assert.equal(raw.violations.length, 1);
  assert.equal(raw.violations[0].model, "SafetyEvent");
});

test("only conversations' own two directories may write its four rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the four rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `Thread`.
  const FOUR = [
    ["thread", "Thread"],
    ["turn", "Turn"],
    ["step", "Step"],
    ["postmanExecution", "PostmanExecution"],
  ];

  for (const [delegate, model] of FOUR) {
    // The delegate directory: legal, and the reason the four stores can exist.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/conversations/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `governance` is the pointed choice — three of
    // its five rows hang off a `Thread` or a `Turn`, it reads all three through
    // inverted read-seam ports precisely because it may not write them, and it
    // is delegated to the SAME directory, so this is the case that proves the
    // boundary is the owner TAG rather than the directory.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/governance/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/governance");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/conversations",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/outbox/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // AND RAW SQL IS NOT A WAY ROUND IT. The compaction lock is a literal
  // `UPDATE "Thread"`, so the gate attributes it to the table its SQL names:
  // legal from the delegated directory, and the same refusal a delegate call
  // would be from anywhere else.
  const lock =
    'db.$executeRaw`UPDATE "Thread" SET "compactionState" = \'IN_PROGRESS\' WHERE "id" = $1`;';
  assert.deepEqual(
    checkWriteEnforcement(fixture({ "packages/adapters/postgres-tenancy/src/x.ts": lock }))
      .violations,
    [],
  );
  const rawTrespass = checkWriteEnforcement(
    fixture({ "packages/contexts/channels/application/steal.ts": lock }),
  );
  assert.equal(rawTrespass.violations.length, 1);
  assert.equal(rawTrespass.violations[0].model, "Thread");
});

test("only memory's own two directories may write its three rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // All THREE rows are checked rather than a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `Memory`.
  const THREE = [
    ["memory", "Memory"],
    ["memoryEntity", "MemoryEntity"],
    ["memoryRelationship", "MemoryRelationship"],
  ];

  for (const [delegate, model] of THREE) {
    // The delegate directory: legal, and the reason the two repositories can
    // exist at all — ADR M0.3 §2 forbids `packages/contexts/memory` from holding
    // the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ "packages/adapters/postgres-tenancy/src/x.ts": write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree for exactly that reason.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ "packages/contexts/memory/application/x.ts": write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `conversations` is the pointed choice — it owns
    // the `Thread` and `Turn` every extracted memory points at, and is the
    // context most plausibly tempted to write one — and it is exactly as refused
    // as anything else.
    const trespass = checkWriteEnforcement(
      fixture({ "packages/contexts/conversations/application/x.ts": write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/conversations");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/memory",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ "packages/adapters/outbox/src/x.ts": write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // And the widening did not licence the directory over rows `memory` does not
  // own. This tranche's branch used `Thread` here; merged, `conversations` is
  // delegated to this same directory and a write to `Thread` from it is legal.
  // The witness was then `Artifact` until `files` was delegated too, and is now
  // `AgentApproval` — `jobs`' row (§1 row 12), which `MemoryRepository` never
  // touches and which no owner has delegated here. A WRITE to it from here is
  // still refused, which is what makes "reads are unrestricted" a bounded
  // statement rather than an open door.
  const readOnlyPeers = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/memory-y.ts": write("agentApproval", "update"),
    }),
  );
  assert.equal(readOnlyPeers.violations.length, 1);
  assert.equal(readOnlyPeers.violations[0].model, "AgentApproval");
  assert.equal(readOnlyPeers.violations[0].expected, "packages/contexts/jobs");
});

test("the RAW `UPDATE` that carries a vector is attributed to `memory`, not waved through", () => {
  // `Memory.embedding` and `MemoryEntity.embedding` are
  // `Unsupported("vector(1536)")`, so the generated client cannot write them and
  // `memory-vectors.ts` sends raw SQL. That is the FIRST canonical write in this
  // tree with no delegate form, and it is judged by the table it names rather
  // than exempted for being raw.
  const permitted = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/memory-vectors.ts":
        'const rows = await db.$executeRaw`UPDATE "Memory" SET "embedding" = ${v}::vector WHERE "id" = ${id}::uuid`;\n',
    }),
  );
  assert.deepEqual(permitted.violations, []);
  assert.equal(permitted.writeCount, 1, "the raw write must be SEEN, not merely un-flagged");

  const trespass = checkWriteEnforcement(
    fixture({
      "packages/contexts/conversations/application/x.ts":
        'const rows = await db.$executeRaw`UPDATE "Memory" SET "embedding" = ${v}::vector`;\n',
    }),
  );
  assert.equal(trespass.violations.length, 1);
  assert.equal(trespass.violations[0].model, "Memory");

  // And a raw statement whose TABLE is interpolated is unattributable from
  // everywhere, including from the one directory entitled to write the row —
  // which is why the two statements in `memory-vectors.ts` are static templates
  // whose only interpolations are VALUES.
  const dynamic = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/memory-z.ts":
        'const rows = await db.$executeRaw`UPDATE "${table}" SET "embedding" = NULL`;\n',
    }),
  );
  assert.equal(dynamic.unattributable.length, 1);
  assert.deepEqual(dynamic.violations, []);
});

test("only secrets' own two directories may write its four rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the four rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `Credential`.
  const FOUR = [
    ["credential", "Credential"],
    ["credentialSecretVersion", "CredentialSecretVersion"],
    ["credentialAudit", "CredentialAudit"],
    ["environmentVariable", "EnvironmentVariable"],
  ];

  for (const [delegate, model] of FOUR) {
    // The delegate directory: legal, and the reason the repositories can exist.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/secrets/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `providers` is the pointed choice — the
    // extraction source writes `ProviderKey` and `Credential` in ONE method, so
    // it is the context that would most plausibly reach for a credential, and it
    // is exactly as refused as anything else.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/providers/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/providers");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/secrets",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    assert.equal(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/outbox/src/x.ts`]: write(delegate, "create") }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // AND THE RAW-SQL DOOR IS JUDGED THE SAME WAY. `purgeSecretVersion` is a
  // `DELETE … USING` written as a literal, so the gate attributes it to the
  // table its SQL names. From the delegated directory it is legal; from anywhere
  // else it is the same refusal a delegate call would be.
  const rawDelete =
    'db.$queryRaw`DELETE FROM "public"."CredentialSecretVersion" AS version' +
    ' USING "public"."Credential" AS credential WHERE version."id" = 1`;';
  assert.deepEqual(
    checkWriteEnforcement(
      fixture({ "packages/adapters/postgres-tenancy/src/x.ts": rawDelete }),
    ).violations,
    [],
  );
  const rawTrespass = checkWriteEnforcement(
    fixture({ "packages/contexts/providers/application/x.ts": rawDelete }),
  );
  assert.equal(rawTrespass.violations.length, 1);
  assert.equal(rawTrespass.violations[0].model, "CredentialSecretVersion");
});

test("only providers' own two directories may write its four rows", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // Every one of the four rows is checked, not a representative one, because the
  // grant is per row and a map entry lost for a single model would otherwise sit
  // here unnoticed behind a green case for `ProviderKey`.
  const FOUR = [
    ["providerKey", "ProviderKey"],
    ["environmentProvider", "EnvironmentProvider"],
    ["model", "Model"],
    ["modelPrice", "ModelPrice"],
  ];

  for (const [delegate, model] of FOUR) {
    // The delegate directory: legal, and the reason the repository can exist.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/adapters/postgres-tenancy/src/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its canonical-store adapter`,
    );
    // The owning context itself: also legal, and never exercised in the live
    // tree, because ADR M0.3 §2 forbids that package from holding the client.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ [`packages/contexts/providers/application/x.ts`]: write(delegate, "create") }),
      ).violations,
      [],
      `${model} must be writable from its owning context`,
    );
    // ANY THIRD PLACE: refused. `secrets` is the pointed choice — the extraction
    // source writes `ProviderKey` and `Credential` in ONE method, so it is the
    // context that would most plausibly reach for a provider key, and it is
    // exactly as refused as anything else even though its OWN rows are written
    // from the very same adapter directory.
    const trespass = checkWriteEnforcement(
      fixture({ [`packages/contexts/secrets/application/x.ts`]: write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `a foreign write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.equal(trespass.violations[0].actual, "packages/contexts/secrets");
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/providers",
      "packages/adapters/postgres-tenancy",
    ]);
    // And a SIBLING canonical-store adapter is not a loophole either: being an
    // adapter is not the qualification, being THIS owner's declared store is.
    // `model-router-providers` is the pointed choice here — `ADAPTER_BINDINGS`
    // gives it a port whose OWNER is `providers`, and owning the port is not
    // owning the rows.
    assert.equal(
      checkWriteEnforcement(
        fixture({
          [`packages/adapters/model-router-providers/src/x.ts`]: write(delegate, "create"),
        }),
      ).violations.length,
      1,
      `${model} must be refused from an adapter that is not its canonical store`,
    );
  }

  // AND THE RAW-SQL DOOR IS JUDGED THE SAME WAY. `touchProviderKey` is a raw
  // single-column `UPDATE` — it has to be, because `ProviderKey.updatedAt` is
  // `@updatedAt` and the client sets it on every delegate write — so the gate
  // attributes it to the table its SQL names. From the delegated directory it is
  // legal; from anywhere else it is the same refusal a delegate call would be.
  const rawTouch =
    'db.$executeRaw`UPDATE "ProviderKey" SET "lastUsedAt" = now() WHERE "id" = \'x\'`;';
  assert.deepEqual(
    checkWriteEnforcement(
      fixture({ "packages/adapters/postgres-tenancy/src/x.ts": rawTouch }),
    ).violations,
    [],
  );
  const rawTrespass = checkWriteEnforcement(
    fixture({ "packages/contexts/secrets/application/x.ts": rawTouch }),
  );
  assert.equal(rawTrespass.violations.length, 1);
  assert.equal(rawTrespass.violations[0].model, "ProviderKey");
});

test("the shared directory is not a blanket licence over the whole schema", () => {
  // The converse of the case above, and the one that would catch a delegation
  // written as "this directory may write anything". `AgentApproval` and
  // `ErasureOperation` live in the same PostgreSQL database, behind the same
  // client, in reach of the same file — and are refused from the directory that
  // legally writes 112 rows.
  //
  // WIN-258 T5 REPLACED `Turn` HERE WITH `Artifact` AND THEN `Artifact` WITH
  // `AgentApproval`, and each substitution is the point rather than a repair.
  // `Turn` was the second name because it was undelegated; that tranche
  // delegated `conversations`. `Artifact` replaced it and this tranche delegates
  // `files`. `AgentApproval` is `jobs`' (ADR M0.3 §1 row 12), is still
  // undelegated, and — like both before it — hangs off a `Thread` this directory
  // now writes, so it is the same shape of proof: adjacency in the schema is not
  // permission.
  for (const [delegate, model] of [
    // Every delegated row has now left these pairs, which is exactly what a case
    // about the boundary should look like as the boundary moves: leaving one
    // here would make the case pass while asserting the opposite of what it
    // says. `AgentApproval` is `jobs`' and `ErasureOperation` is `privacy`',
    // neither of which has a canonical-store adapter, and both live in the same
    // database behind the same client.
    ["agentApproval", "AgentApproval"],
    ["erasureOperation", "ErasureOperation"],
  ]) {
    const result = checkWriteEnforcement(
      fixture({ "packages/adapters/postgres-tenancy/src/x.ts": write(delegate, "create") }),
    );
    assert.equal(result.violations.length, 1, `${model} must be refused from the shared directory`);
    assert.equal(result.violations[0].model, model);
  }
});

test("the gate is not foolable by a delegate name in a string, a comment or a type", () => {
  const root = fixture({
    "packages/contexts/files/application/x.ts":
      `// await db.user.create({});\n` +
      `const sql = "db.user.create({})";\n` +
      `type W = { user: { create: () => void } };\n` +
      `export type { W };\nexport const sqlText = sql;\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 0);
});

test("a write reached through a transaction handle is still a write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(tx: any) {\n  await tx.accessKey.updateMany({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, "AccessKey");
});

test("delegate naming round-trips, including the OAuth models", () => {
  assert.equal(delegateName("User"), "user");
  assert.equal(delegateName("OAuthClient"), "oAuthClient");
  assert.equal(delegateName("McpToken"), "mcpToken");
  for (const model of Object.keys(OWNER)) {
    assert.equal(modelForDelegate(delegateName(model)), model, model);
  }
});

test("owningPackage resolves a file to its package, and nothing else", () => {
  assert.equal(owningPackage("packages/contexts/tenancy/domain/a.ts"), "packages/contexts/tenancy");
  assert.equal(owningPackage("packages/adapters/outbox/src/a.ts"), "packages/adapters/outbox");
  assert.equal(owningPackage("apps/core-api/src/main.ts"), null);
});

test("findWrites reports position and method, so a failure is actionable", () => {
  const found = findWrites("packages/contexts/x/a.ts", `\n\nawait db.budget.upsert({});\n`).writes;
  assert.equal(found.length, 1);
  assert.equal(found[0].model, "Budget");
  assert.equal(found[0].method, "upsert");
  assert.equal(found[0].line, 3);
});

// ---------------------------------------------------------------------------
// The seven evasion probes from the 2026-09-02 independent verification.
//
// SIX of these were invisible to the check as shipped at 3ed8f3ce, because the
// matcher required a literal two-level `X.<delegate>.<mutator>()`. Each probe
// is a negative control in its own right: it writes `User`, which
// identity-access owns, from `tenancy`, which does not. If the detector stops
// seeing one of them, the assertion goes red rather than the suite going quiet.
// ---------------------------------------------------------------------------

const PROBES = Object.freeze({
  "direct delegate call": `export async function run(db: any) {\n  await db.user.create({});\n}\n`,
  "element-access delegate": `export async function run(db: any) {\n  await db["user"].create({});\n}\n`,
  "destructured delegate": `export async function run(db: any) {\n  const { user } = db;\n  await user.create({});\n}\n`,
  "renamed destructured delegate": `export async function run(db: any) {\n  const { user: u } = db;\n  await u.create({});\n}\n`,
  "aliased delegate": `export async function run(db: any) {\n  const u = db.user;\n  await u.create({});\n}\n`,
  "aliased element-access delegate": `export async function run(db: any) {\n  const u = db["user"];\n  await u.deleteMany({});\n}\n`,
  "computed method on a delegate": `export async function run(db: any, m: string) {\n  await db.user[m]({});\n}\n`,
  "raw INSERT through $executeRawUnsafe": `export async function run(db: any) {\n  await db.$executeRawUnsafe('INSERT INTO "User" (id) VALUES (1)');\n}\n`,
  "raw INSERT through a $queryRaw tagged template": `export async function run(db: any, id: string) {\n  await db.$queryRaw\`INSERT INTO "User" (id) VALUES (\${id})\`;\n}\n`,
  "raw UPDATE through $executeRaw": `export async function run(db: any) {\n  await db.$executeRaw\`UPDATE "User" SET name = 'x'\`;\n}\n`,
  "raw DELETE through $queryRawUnsafe": `export async function run(db: any) {\n  await db.$queryRawUnsafe('DELETE FROM "User" WHERE id = 1');\n}\n`,
});

for (const [label, source] of Object.entries(PROBES)) {
  test(`EVASION PROBE — ${label} is caught writing a row tenancy does not own`, () => {
    const root = fixture({ "packages/contexts/tenancy/application/rogue.ts": source });
    const result = checkWriteEnforcement(root);
    assert.equal(
      result.violations.length + result.unattributable.length,
      1,
      `${label} produced ${JSON.stringify(result)}`,
    );
    if (result.violations.length === 1) {
      assert.equal(result.violations[0].model, "User");
      assert.equal(result.violations[0].expected, "packages/contexts/identity-access");
    }
  });

  test(`EVASION PROBE — ${label} is PERMITTED from the owning package`, () => {
    const root = fixture({ "packages/contexts/identity-access/application/mint.ts": source });
    const result = checkWriteEnforcement(root);
    assert.deepEqual(result.violations, [], label);
    assert.deepEqual(result.unattributable, [], label);
    assert.equal(result.writeCount, 1, `${label} must be SEEN in the owning package, not merely un-flagged`);
  });
}

test("a computed DELEGATE cannot be attributed, so it fails in every package", () => {
  const source =
    `export async function run(db: any, name: string) {\n` +
    `  await db.user.findMany({});\n` +
    `  await db[name].create({});\n}\n`;
  for (const owner of ["identity-access", "tenancy"]) {
    const root = fixture({ [`packages/contexts/${owner}/application/x.ts`]: source });
    const result = checkWriteEnforcement(root);
    assert.equal(result.unattributable.length, 1, owner);
    assert.equal(result.unattributable[0].reason, "computed-delegate");
  }
});

test("a raw statement assembled at runtime cannot be attributed, so it fails in every package", () => {
  const source = `export async function run(db: any, sql: string) {\n  await db.$executeRawUnsafe(sql);\n}\n`;
  for (const owner of ["identity-access", "tenancy"]) {
    const root = fixture({ [`packages/contexts/${owner}/application/x.ts`]: source });
    const result = checkWriteEnforcement(root);
    assert.equal(result.unattributable.length, 1, owner);
    assert.equal(result.unattributable[0].reason, "raw-sql-not-static");
  }
});

test("a raw statement whose table is interpolated cannot be attributed", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/x.ts":
      `export async function run(db: any, t: string) {\n  await db.$executeRaw\`INSERT INTO \${t} (id) VALUES (1)\`;\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.unattributable.length, 1);
  assert.equal(result.unattributable[0].reason, "raw-sql-unknown-table");
});

test("a raw statement naming a table no canonical model claims cannot be attributed", () => {
  const root = fixture({
    "packages/contexts/identity-access/application/x.ts":
      `export async function run(db: any) {\n  await db.$executeRawUnsafe('INSERT INTO "SomeLegacyTable" (id) VALUES (1)');\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.unattributable.length, 1);
  assert.equal(result.unattributable[0].reason, "raw-sql-unknown-table");
});

test("a raw statement that only READS is exempt, exactly as a findMany is", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n` +
      `  await db.$queryRaw\`SELECT id FROM "User" WHERE id = 1 FOR UPDATE\`;\n` +
      `  await db.$executeRaw\`SET LOCAL statement_timeout = 5000\`;\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 0);
});

test("ON CONFLICT DO UPDATE is one INSERT, not an INSERT and a stray UPDATE", () => {
  const found = findSqlMutations(
    `INSERT INTO "User" (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1`,
    canonicalTables(),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].statement, "insert into");
  assert.equal(found[0].model, "User");
});

test("a mutating verb inside a SQL comment is prose, not a write", () => {
  const found = findSqlMutations(`-- update the audit row\nSELECT 1`, canonicalTables());
  assert.deepEqual(found, []);
});

test("raw attribution follows @@map, so the PHYSICAL table name resolves", () => {
  // Derived from the schema rather than transcribed: the one `@@map`ped model
  // carries an inherited physical name that the vocabulary boundary does not
  // permit in authored V1 source, and hard-coding it here would spread it.
  const tables = readSchemaTables();
  const remapped = [...tables].filter(([table, model]) => table !== model.toLowerCase());
  assert.equal(remapped.length, 1, "the canonical schema has exactly one @@map'd model");
  const [physical, model] = remapped[0];
  assert.equal(tables.has(model.toLowerCase()), false, "the model name is NOT the table name here");

  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n  await db.$executeRawUnsafe('DELETE FROM "${physical}" WHERE id = 1');\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].model, model);
  assert.equal(result.violations[0].expected, ownerDirectory(OWNER[model]));
  assert.notEqual(result.violations[0].expected, "packages/contexts/tenancy");
});

// This is the live-tree finding that decided the fail-closed AXIS. Failing
// closed on an unrecognised METHOD NAME reported four calls in identity-access
// that are not Prisma at all — `ports.repository.impersonationAudit.append()` is
// a domain port named after the row it owns. A name in neither Prisma list is
// evidence the receiver was never a delegate.
test("a method in neither Prisma list is a domain port, not a hidden write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(ports: any, entry: any) {\n` +
      `  await ports.repository.impersonationAudit.append(entry);\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 0);
});

test("reads on a resolved delegate are counted, so the gate can show it is not blind", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(db: any) {\n  await db.user.findMany({});\n  await db["user"].count({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.equal(result.writeCount, 0);
  assert.equal(result.readCount, 2, "a read must be SEEN and exempted, not merely unmatched");
});

test("the read list and the write list do not overlap, and both are non-empty", () => {
  const overlap = READ_DELEGATE_METHODS.filter((method) => MUTATING_DELEGATE_METHODS.includes(method));
  assert.deepEqual(overlap, []);
  assert.ok(READ_DELEGATE_METHODS.length >= 6);
  assert.deepEqual([...RAW_SQL_METHODS].sort(), [
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRaw",
    "$queryRawUnsafe",
  ]);
});

test("an element-access member that is not a delegate is still not a write", () => {
  const root = fixture({
    "packages/contexts/tenancy/application/x.ts":
      `export async function run(rows: any[], i: number) {\n  rows[i].create({});\n  rows["thing"].delete({});\n}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
});

// WIN-258 switched the write half on. The count is pinned with its arithmetic
// written out, so a deletion cannot hide inside an addition:
//
//   src/tree.ts        organization.upsert, project.upsert, environment.upsert          3
//   src/membership.ts  organizationMembership.upsert x2, projectMembership.upsert        3
//   src/invitation.ts  organizationInvitation.upsert + .updateMany, entity.upsert,
//                      environmentSession.upsert                                        4
//   the integration suite  organization.delete (the cascade case),
//                      environment.create (the expand/contract case)                    2
//                                                                              total = 12
//
// Every one of the twelve is a row `tenancy` owns, written from `tenancy`'s
// canonical-store adapter.
//
// WIN-258 TRANCHE 2 adds 51, all from the SAME directory, on the 23 rows
// `identity-access` owns plus one `Environment` write that is `tenancy`'s and
// is the reason both contexts' repositories share a directory at all (ADR M0.3
// §15). Written out so a deletion cannot hide inside an addition:
//
//   src/identity-users.ts       user.create, operatorIdentity.upsert            2
//   src/identity-sessions.ts    operatorSession.upsert + .updateMany,
//                               magicLinkToken.create + .updateMany             4
//   src/identity-mfa.ts         operatorMfaTotp.upsert/.deleteMany/.updateMany,
//                               operatorMfaRecoveryCode.updateMany/.deleteMany/
//                               .createMany                                     6
//   src/identity-access-keys.ts accessKey.create, .update x2, .updateMany,
//                               AND environment.update — the revocation fence,
//                               a TENANCY row, legal only because this
//                               directory is also tenancy's delegate           5
//   src/identity-oauth.ts       oAuthAuthorizationCode.updateMany,
//                               oAuthAccessToken.create + .updateMany,
//                               oAuthRefreshToken.create + .updateMany x2       6
//   src/identity-bearer.ts      updateMany on each of the FOUR bearer tables    4
//   src/identity-end-users.ts   impersonationAudit.create                       1
//   src/identity-harness.ts     five seeded rows the PORT cannot create,
//                               as raw INSERTs                                  5
//   src/identity-differential-harness.ts  user.create (the oracle's operator)   1
//   the identity suites         12 constraint proofs (raw), 2 differential,
//                               2 differential-login, 1 transaction            17
//                                                                      total = 51
//
// WIN-258 TRANCHE 3 adds 3, again all from the SAME directory, and they are
// worth writing out individually because three is small enough that a reader
// would otherwise wonder what five new ports could possibly write:
//
//   src/access-key-revocation.ts  environment.update — the ONE tenancy-owned
//                                 write the whole tranche makes, and the fence
//                                 ADR M0.3 §15 was argued on                    1
//   src/ports-harness.ts          a raw INSERT of an `Environment` row with no
//                                 `accessKeyRevocationVersion` column, which is
//                                 the expand/contract fixture: the generated
//                                 client cannot express a write that omits a
//                                 non-optional column                           1
//   src/ports-conformance.integration.test.ts
//                                 a raw UPDATE disabling a `User`, so the
//                                 operator directory can be asked about a
//                                 disabled account. identity-access's row,
//                                 legal from this directory for the same reason
//                                 the 51 above are                              1
//                                                                       total = 3
//
// FOUR OF THE FIVE PORTS WRITE NOTHING AT ALL, and that is the property to hold
// on to rather than the number. Both locks are `SELECT ... FOR UPDATE` and an
// advisory-lock function call, which the `(?<!\bfor )` lookbehind in
// `MUTATING_SQL_STATEMENT` correctly declines to read as an UPDATE; the session
// revoker delegates to identity-access's own store rather than issuing its own
// statement, so its write is already counted among the 51; the operator
// directory only reads; and the token issuer touches no database.
//
// WIN-258 TRANCHE 4 adds 3, and they are the first writes in the tree that
// belong to an owner which is not a context at all:
//
//   src/outbox-store.ts        event.create — THE single writer of the Event
//                              row, on the `<kernel-outbox-adapter>` owner       1
//   src/outbox-harness.ts      a raw INSERT INTO "public"."Event" seeding the
//                              pre-envelope row the legacy producer writes and
//                              the outbox store cannot                            1
//   the outbox suites          environment.delete — the ON DELETE CASCADE case,
//                              a TENANCY row, legal for the same reason the
//                              revocation fence above is                          1
//                                                                        total = 3
//
// WIN-258 TRANCHE 5 adds 17, from the SAME directory again, on the ten rows
// `tools` owns. It is the largest single addition since tranche 2 because the
// port is 25 methods wide, and it is written out per FILE so a deletion cannot
// hide inside an addition:
//
//   src/tools-catalogue.ts    tool.create — the ONE catalogue write; the
//                             fingerprint read that precedes it is a read       1
//   src/tools-exposures.ts    environmentEntityTool.deleteMany, .updateMany,
//                             .createMany, .updateMany — `replaceExposures` is
//                             three of these in ONE transaction and
//                             `setExposureEnabled` is the fourth               4
//   src/tools-policies.ts     entityToolPolicy.upsert,
//                             organizationMcpPolicy.upsert + .deleteMany        3
//   src/tools-mcp.ts          entityMcpConfig.upsert, entityMcpClient.upsert    2
//   src/tools-transcript.ts   toolCall.upsert, toolHealth.upsert,
//                             toolCallAudit.create                              3
//   src/tools-harness.ts      a raw INSERT of a `ToolCallAudit` row — the
//                             append-only table the PORT may only append to,
//                             seeded here so `pageAudit` has a window to page   1
//   the tools suites          3 constraint proofs, all raw and all migrations-
//                             only: a `ToolCall` status UPDATE, a `Tool`
//                             INSERT, an `EntityMcpConfig` UPDATE               3
//                                                                      total = 17
//
// `AgentToolPolicy` is one of the ten rows `tools` owns and NOTHING IN THE TREE
// writes it — not this directory and not anywhere else, which the enumeration
// above is the whole of the evidence for. `ToolsRepository` only READS it, as
// the fold behind `listAgentPolicyBindings`/`findAgentPolicyBinding`, and no
// port in this context declares a method that creates one. So nine of the ten
// rows are written from here and the tenth is read-only for now. That is a
// PORT-SURFACE gap rather than a sole-writer hole: whoever adds the writer must
// add it to this directory, because `tools` owns the row and this map grants it
// to exactly one place.
//
// 12 + 51 + 3 + 3 + 17 = 86. FOUR tranches have now added to the same directory,
// and merged the pin is the SUM. Each branch independently wrote `12 + 51 + 3 = 66`
// and each was right alone — which is why this line merged with no textual
// conflict at all and would have shipped three writes short of the tree. The
// second and third assertions below say the writes are all legal and all
// attributable, so the pin cannot be satisfied by 157 mutations somewhere else.
//
// WIN-258 TRANCHE 5 adds 27, again all from the SAME directory, on the SEVEN
// rows `agents` owns. Written out so a deletion cannot hide inside an addition:
//
//   src/agents-catalog.ts       agent.create, agent.updateManyAndReturn,
//                               agentBinding.create + .updateManyAndReturn +
//                               .deleteMany                                     5
//   src/agents-versions.ts      agentVersion.create, agentSkill.deleteMany,
//                               agentSkill.createManyAndReturn                  3
//   src/agents-clusters.ts      agentCluster.create + .updateManyAndReturn +
//                               .deleteMany, AND agentBinding.updateMany --
//                               detaching a cluster's members is a BINDING
//                               write, which is why the port keeps it separate
//                               from the delete                                 4
//   src/agents-scaffolding.ts   macro.create + .updateManyAndReturn +
//                               .deleteMany, postmanTemplate.create +
//                               .updateManyAndReturn + .deleteMany              6
//   src/agents-constraints.integration.test.ts
//                               SEVEN raw statements naming their table
//                               LITERALLY: an `AgentVersion` INSERT carrying
//                               `enabledTools`, a `DELETE FROM "AgentVersion"`
//                               a binding still serves, a `Macro` INSERT whose
//                               steps are not an array, and the FOUR that plant
//                               a project-crossed binding -- the DDL that puts
//                               the ancestry rule to sleep, the INSERT it would
//                               otherwise have refused, the DDL that wakes it
//                               again, and the DELETE that removes the row       7
//   src/agents-transaction.integration.test.ts
//                               two agent.create calls issued through the
//                               CLIENT rather than the port, which is the
//                               measurement of what a caught refusal costs
//                               without a savepoint                             2
//                                                                       total = 27
//
// THE TWO `ALTER TABLE` STATEMENTS ARE WRITES HERE AND SHOULD BE. This gate
// attributes a raw statement to the table its SQL names, and a statement that
// switches a table's ancestry rule off is exactly the kind of reach into another
// context's rows the gate exists to see -- it is legal only because the file
// sits in the delegated directory. The count was pinned at 23 by a draft written
// before that case existed, which is what a re-derivation catches and a
// carried-forward number does not.
//
// EVERY RAW STATEMENT SPELLS ITS SQL AT THE CALL SITE, and the first draft did
// not: a one-line `raw(sql, ...args)` helper made them all UNATTRIBUTABLE,
// because SQL arriving as an argument names no table. The audit reported it; the
// helper now returns the client and each call carries its own literal.
//
// WIN-258 TRANCHE 5 adds 37, all from the SAME directory, and — unlike every
// tranche before it — EVERY ONE of them is on a row this tranche's own owner
// holds. There is no borrowed `Environment` write here, because none of
// `cost-monitoring`'s six rows carries a fence on somebody else's table. Each
// line below was read back from the enforcer rather than counted by eye:
//
//   src/cost-budgets.ts        budget.createMany, .updateMany x2,
//                              budgetThresholdEvent.createMany                  4
//   src/cost-channels.ts       alertChannel.createMany + .updateMany,
//                              alertChannelConfiguration.create + .updateMany   4
//   src/cost-deliveries.ts     alertDelivery.createMany x2, .updateMany x2,
//                              .updateManyAndReturn, alertDeliveryRetry.create
//                              x2                                              7
//   src/cost-constraints.integration.test.ts
//                              14 raw seeds standing each guard beside the
//                              CHECK it restates — 6 Budget, 3 AlertChannel,
//                              2 AlertDelivery, 2 BudgetThresholdEvent,
//                              1 AlertDeliveryRetry                            14
//   src/cost-rules.integration.test.ts
//                              7 writes proving the database rules NO port
//                              method restates: two immutability rules, the
//                              ancestry rule firing on UPDATE, and the
//                              tombstone this port cannot write                  7
//   src/cost-transaction.integration.test.ts
//                              alertDeliveryRetry.create — the second statement
//                              of the pair failure injection forces to fail      1
//                                                                       total = 37
//
// `src/cost-harness.ts` contributes ZERO, and that is the line worth reading
// rather than a silence, because the fixture needs four rows this package may
// not write and gets them two different ways. `Organization`, `Project` and
// `Environment` it obtains by CALLING the tenancy repositories already in this
// directory, so those statements are counted once, at their own source, among
// the 69. `Agent` and `Credential` it cannot obtain that way at all: `agents`
// and `secrets` have NO entry in `CANONICAL_STORE_ADAPTERS`, so this gate
// refuses a write to either from this directory — and rather than route around
// the refusal, the harness seeds them out of band through the ORM's own CLI
// (`prisma db execute`), which is runtime and therefore out of this scanner's
// scope by construction. Both rows are real foreign keys the six under test
// point at, so the fixture needs them; the gate is why it gets them from
// somewhere else.
//
//
// WIN-258 TRANCHE 5 adds 7 more, all from the SAME directory, and all seven on
// rows `channels` itself owns. Each line was read back from the enforcer rather
// than counted by eye:
//
//   src/channels-connections.ts    channelConnection.upsert,
//                                  channelApp.upsert                             2
//   src/channels-installations.ts  channelInstallation.upsert                    1
//   src/channels-links.ts          channelThread.create,
//                                  channelAppThread.create                       2
//   src/channels-inbox.ts          channelEventInbox.create + .upsert            2
//                                                                        total = 7
//
// ITS FIVE INTEGRATION SUITES CONTRIBUTE ZERO, and that is the line worth
// reading rather than a silence. `channels-constraints.integration.test.ts`
// writes bad values PAST the port on purpose, and every one of them goes through
// `prisma db execute` — the ORM's own CLI, which is runtime and therefore out of
// this scanner's scope by construction — because writing them through this
// package's delegate would be writing them through the guard under test. The
// harness needs five rows this package may not write at all: `Agent`,
// `Credential`, `Entity`, `EndUser` and `Thread`, whose owners have no entry in
// `CANONICAL_STORE_ADAPTERS`. It seeds them the same way, rather than routing
// around a refusal this gate is right to make.
//
//
// WIN-258 TRANCHE 5, `governance` adds 13, all from the SAME directory and all
// on a row its own owner holds. Each line was read back from the enforcer rather
// than counted by eye:
//
//   src/governance-safety.ts        safetyEvent.createManyAndReturn, and the
//                                   ONE updateMany that exists to anonymise      2
//   src/governance-ratings.ts       messageRating.updateMany (the flip),
//                                   .createManyAndReturn (the first vote) and
//                                   .deleteMany TWICE -- a withdrawal and an
//                                   erasure are different operations on the
//                                   same table and the port names them
//                                   separately                                   4
//   src/governance-criteria.ts      evalCriterion.createManyAndReturn,
//                                   .updateMany, .deleteMany                     3
//   src/governance-evals.ts         agentEval.createManyAndReturn, and NOTHING
//                                   else: the port has no update and no delete,
//                                   and the rows that do go are taken by the
//                                   thread's and the criterion's cascades        1
//   src/governance-golden-sets.ts   goldenSet.createManyAndReturn, .updateMany,
//                                   .deleteMany                                  3
//                                                                       total = 13
//
// THE FIVE SUITES CONTRIBUTE ZERO, and that is the line worth reading. Two of
// them plant `SafetyEvent` rows the way the LEGACY source wrote them -- a bare
// attribute bag, and a detector outside the closed set -- and the harness seeds
// an `Agent`, two `AgentVersion`s, an `EndUser`, a `Thread` and two `Turn`s that
// every one of these five tables points at. None of it is counted here, because
// none of it goes through the ORM: `Thread` and `Turn` belong to `conversations`,
// which has NO entry in `CANONICAL_STORE_ADAPTERS`, so this gate refuses a write
// to either from this directory -- and rather than route around the refusal the
// harness applies the whole chain out of band through the ORM's own CLI
// (`prisma db execute`), which is runtime and therefore out of this scanner's
// scope by construction.
//
//
//
// WIN-258 TRANCHE 5 adds 28 more, a FOURTH store in the SAME directory, on the
// FOUR rows `secrets` owns. Every one is on a row this tranche's own owner
// holds — there is no borrowed write here either — and each line was read back
// from the enforcer rather than counted by eye:
//
//   src/secrets-credentials.ts  credential.create,
//                               credential.updateManyAndReturn — ONE patch
//                               function behind `setActiveSecretVersion` and
//                               `revokeCredential`, because four columns are
//                               frozen on UPDATE and two catch blocks would
//                               drift                                          2
//   src/secrets-versions.ts     credentialSecretVersion.create +
//                               .updateManyAndReturn, credentialAudit.create,
//                               and the raw `DELETE FROM …
//                               "CredentialSecretVersion" … USING "Credential"`
//                               that re-checks every purge clause inside the
//                               statement                                      4
//   src/secrets-variables.ts    environmentVariable.upsert + .deleteMany       2
//   src/secrets-constraints.integration.test.ts
//                               12 raw writes standing each guard beside the
//                               CHECK it restates — 5 CredentialSecretVersion,
//                               4 EnvironmentVariable, 1 Credential INSERT,
//                               1 Credential UPDATE and 1 CredentialAudit      12
//   src/secrets-rules.integration.test.ts
//                               8 writes proving the database rules NO port
//                               method restates: the two owner-immutability
//                               rules, the envelope-immutability rule twice,
//                               the append-only audit's UPDATE and DELETE, and
//                               the ON DELETE RESTRICT that stops an ACTIVE
//                               envelope being destroyed                        8
//                                                                       total = 28
//
// `src/secrets-harness.ts` contributes ZERO, and unlike `cost-harness.ts` that
// is because it needs no out-of-band seed at all: `Credential` is now this
// directory's to write, so the vault's own rows go through the vault's own port
// — which is also the only way its conformance differential could be one.
// `src/secrets-transaction.integration.test.ts` and
// `src/secrets-statements.integration.test.ts` contribute zero for the same
// reason: every row they need is written through the port under measurement.
//
//
//   WIN-258 T5, `skills`' canonical store — SIX, and every one of them in
//   `packages/adapters/postgres-tenancy/src/`:
//
//   src/skills-catalogue.ts     skill.upsert + skill.updateManyAndReturn       2
//   src/skills-installations.ts projectSkill.upsert, environmentSkill.upsert
//                               and environmentSkill.deleteMany                3
//   src/skills-erasure.ts       the raw `UPDATE "Skill" … jsonb_set(...)` that
//                               overwrites the author in the COLUMN and in the
//                               stored manifest in ONE statement               1
//                                                                        total = 6
//
// Its FIVE suites contribute ZERO between them, and for two different reasons
// worth keeping apart. `skills-conformance`, `-constraints`, `-transaction` and
// `-statements` write every row they need through the port under measurement,
// because `Skill`, `ProjectSkill` and `EnvironmentSkill` are now this
// directory's to write and the tenant tree above them already was.
// `skills-rules.integration.test.ts` plants rows this store REFUSES to write —
// an unknown `origin`, a NULL `tags`, a manifest missing a required key — and
// applies them through `prisma db execute`, which is the ORM's CLI at runtime
// and not a client call at all, so the scanner neither sees them nor should.
//
//
// WIN-258 T5 — THE `memory` CANONICAL STORE adds FIFTEEN, and TWO of them are
// raw SQL rather than delegate calls, which is the first time that has been true
// of a write in this tree:
//
//   src/memory-store.ts            create, update, deleteMany, a second update
//                                  for the reconciled confidence, and the raw
//                                  `UPDATE "Memory" SET "lastAccessedAt"` that
//                                  keeps recall from bumping `@updatedAt`      5
//   src/memory-vectors.ts          the two raw `UPDATE`s that carry a
//                                  `vector(1536)`. The column is `Unsupported`
//                                  in `schema.prisma`, so the generated client
//                                  can neither select nor set it and there is
//                                  no delegate form of this write at all.
//                                  `MUTATING_SQL_STATEMENT` attributes each by
//                                  the TABLE it names — `Memory` and
//                                  `MemoryEntity` — exactly as it would a
//                                  delegate call                               2
//   src/memory-entities.ts         create, update, deleteMany                  3
//   src/memory-relationships.ts    create, update                              2
//   src/memory-erasure.ts          three deleteMany, one per table, because a
//                                  cascade reports no count and a receipt has
//                                  to                                          3
//                                                                       total = 15
//
// `src/memory-harness.ts` contributes ZERO and its `UPDATE "MemoryEntity" SET
// "embedding"` is not one of them: it is a STRING handed to `prisma db execute`,
// not a call to `$executeRaw`, so the scanner never sees it — which is the same
// out-of-band seed the other harnesses use for rows this directory may not
// write, applied here to a column no port method can.
//
//
//
// WIN-258 T5 — THE `files` CANONICAL STORE adds FIVE, and TWO of them are raw
// SQL for reasons the delegate API cannot serve:
//
//   src/files-attachments.ts       create, updateMany and deleteMany. The update
//                                  is `updateMany` rather than `update` because
//                                  the four owner columns are in its WHERE:
//                                  `MessageAttachment_owner_immutable` refuses a
//                                  move, so a caller that mutated the owner has
//                                  to be told NOT FOUND rather than have the
//                                  move silently dropped                       3
//   src/files-artifacts.ts         the raw `INSERT INTO "Artifact" ... ON
//                                  CONFLICT DO NOTHING RETURNING "id"`. A plain
//                                  insert would let the append-only unique ABORT
//                                  the caller's whole transaction, and the port
//                                  requires the conflict to be an outcome a
//                                  caller can act on. `MUTATING_SQL_STATEMENT`
//                                  attributes it by the TABLE it names, exactly
//                                  as it would a delegate call                 1
//   src/files-erasure.ts           the raw `DELETE FROM "Artifact" USING
//                                  "Environment", "Project"`. The count has to
//                                  be the number of rows that actually went, and
//                                  the join that resolves containment and the
//                                  delete that acts on it cannot be allowed to
//                                  disagree                                    1
//                                                                        total = 5
//
// `src/files-harness.ts` contributes ZERO, and its `INSERT INTO "Thread"` and
// `INSERT INTO "Turn"` are not among them: they are STRINGS handed to
// `prisma db execute`, not calls to `$executeRaw`, so the scanner never sees
// them — which is the same out-of-band seed every other harness uses for rows
// its directory may not write, applied here to the five peers
// `MessageAttachment_ancestry` demands.
//
// 12 + 51 + 3 + 3 + 17 + 27 + 37 + 7 + 13 + 28 + 17 + 30 + 6 + 15 + 5 = 271. All
// of tranche 5's stores landed in the ONE directory, so this pin is the SUM of
// every enumeration above and no single branch's own figure — 215, 228, 204 or
// 213 — survives the merge.
const LIVE_TREE_WRITE_COUNT = 271;

test("the live tree's writes are exactly the postgres-tenancy adapter's, on tenancy's rows", () => {
  const result = check();
  assert.equal(
    result.enforcement.writeCount,
    LIVE_TREE_WRITE_COUNT,
    "the write count moved; re-derive the arithmetic above rather than editing the number",
  );
  assert.deepEqual(result.enforcement.violations, []);
  assert.deepEqual(result.enforcement.unattributable, []);
  assert.equal(failures(result), 0);
  assert.ok(result.enforcement.fileCount > 0, "the scan must have read something");
});

test("the canonical-store delegation is the ONLY reason those writes are legal", () => {
  // Deleting `postgres-tenancy` from the permitted set must make all sixty-nine
  // illegal. A permission nothing depends on is a permission that is not doing
  // anything, and this is the case that proves it is.
  assert.deepEqual(ownerDirectories("tenancy"), [
    "packages/contexts/tenancy",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.tenancy, "packages/adapters/postgres-tenancy");
  // WIN-258 T2: identity-access is delegated to the SAME directory, because one
  // PostgreSQL database is one client is one adapter (ADR M0.3 §15).
  assert.deepEqual(ownerDirectories("identity-access"), [
    "packages/contexts/identity-access",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS["identity-access"], "packages/adapters/postgres-tenancy");
  // WIN-258 T5: cost-monitoring is the FIFTH context delegated to that same
  // directory, for the same §15 reason.
  assert.deepEqual(ownerDirectories("cost-monitoring"), [
    "packages/contexts/cost-monitoring",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS["cost-monitoring"], "packages/adapters/postgres-tenancy");
  // And that grant is exactly SIX rows wide. This is the assertion that keeps
  // five owners sharing one directory from quietly becoming one directory that
  // may write anything: the boundary is the owner TAG on the row, and the tag is
  // read per write.
  const costRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "cost-monitoring")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(costRows, [
    "AlertChannel",
    "AlertChannelConfiguration",
    "AlertDelivery",
    "AlertDeliveryRetry",
    "Budget",
    "BudgetThresholdEvent",
  ]);
  // The delegation is granted PER OWNER and never derived from the adapter
  // table's owner column. `redis-ratelimit` is also owned by identity-access and
  // `notifier-email` by cost-monitoring; neither is a canonical store, and an
  // owner with no entry here still has exactly one permitted directory — which
  // is what stops the shared directory from becoming a blanket licence.
  //
  // `jobs` carries that negative now that `files` has been delegated too.
  // It is not a decorative example: `packages/adapters/postgres-tenancy` holds
  // repositories for THIRTEEN owners, and `Job` is a row in the very same
  // PostgreSQL database, reachable through the very same client, whose write
  // from this directory is still refused.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, undefined);
  assert.deepEqual(ownerDirectories("jobs"), ["packages/contexts/jobs"]);
  // WIN-258 T5: `agents` is delegated to the SAME directory a fourth time, and
  // the grant is exactly the SEVEN rows ADR M0.3 §1 row 5 gives it.
  assert.deepEqual(ownerDirectories("agents"), [
    "packages/contexts/agents",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.agents, "packages/adapters/postgres-tenancy");
  const agentRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "agents")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(agentRows, [
    "Agent",
    "AgentBinding",
    "AgentCluster",
    "AgentSkill",
    "AgentVersion",
    "Macro",
    "PostmanTemplate",
  ]);
  // WIN-258 T5: `secrets` is the SIXTH owner delegated to that directory, and
  // the grant is exactly the FOUR rows ADR M0.3 §1 row 3 gives it. It is the
  // one owner whose ADR row lists FIVE — `SecretReference` is the fifth — and
  // `UNOWNED_ADR_ROWS` records that it is not in the canonical schema at all, so
  // there is nothing here to grant.
  assert.deepEqual(ownerDirectories("secrets"), [
    "packages/contexts/secrets",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.secrets, "packages/adapters/postgres-tenancy");
  const secretRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "secrets")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(secretRows, [
    "Credential",
    "CredentialAudit",
    "CredentialSecretVersion",
    "EnvironmentVariable",
  ]);
  // WIN-258 T5: `providers` is the NINTH owner delegated to that directory, and
  // the grant is exactly the FOUR rows ADR M0.3 §1 row 4 gives it. It is the
  // entry the `secrets` comment above said was missing: the extraction source
  // writes `ProviderKey` inside its own secret store, `domain/credential.ts`
  // records that those three methods were left unextracted for exactly that
  // reason, and the split is now the one the ADR describes — `secrets` owns the
  // credential and its envelope, `providers` owns the row that points at them.
  assert.deepEqual(ownerDirectories("providers"), [
    "packages/contexts/providers",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.providers, "packages/adapters/postgres-tenancy");
  const providerRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "providers")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(providerRows, [
    "EnvironmentProvider",
    "Model",
    "ModelPrice",
    "ProviderKey",
  ]);
  // WIN-258 T5: `skills` is the ELEVENTH owner delegated to that directory, and
  // the grant is exactly the THREE rows ADR M0.3 §1 row 6 gives it. delegated to that directory, and the
  // grant is exactly the THREE rows ADR M0.3 §1 row 6 gives it.
  //
  // THIS ASSERTION USED TO SAY THE OPPOSITE, and the flip is worth naming. Until
  // this tranche `skills` had no entry, which is why the `agents` note above
  // records that its integration fixture seeds the `EnvironmentSkill` its own
  // `AgentSkill` foreign key needs as SQL rather than reaching for a permission
  // the map withheld. The permission now exists — granted to `skills`, tagged
  // `skills`, and used by `skills`' own store — and `agents`' fixture is
  // unchanged, because the grant moved no tag and `agents` still owns none of
  // these three rows.
  assert.deepEqual(ownerDirectories("skills"), [
    "packages/contexts/skills",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.skills, "packages/adapters/postgres-tenancy");
  const skillRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "skills")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(skillRows, ["EnvironmentSkill", "ProjectSkill", "Skill"]);
  // And `jobs` is NOT delegated, which is the negative that still holds after
  // this wave. It USED to be `skills` in the `providers` half of this case,
  // `providers` in the `skills` half and then `files` in both, and each was
  // right alone and wrong once the next tranche landed — this wave grants all
  // three. `jobs` owns `Job` and `AgentApproval`, has no entry in
  // `CANONICAL_STORE_ADAPTERS`, and is what keeps this case a boundary rather
  // than a list of everything that landed.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, undefined);
  assert.deepEqual(ownerDirectories("jobs"), ["packages/contexts/jobs"]);
  // WIN-258 T5: `channels` is delegated to the SAME directory a fifth time, and
  // the grant is exactly the SIX rows ADR M0.3 §1 row 9 gives it.
  assert.deepEqual(ownerDirectories("channels"), [
    "packages/contexts/channels",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.channels, "packages/adapters/postgres-tenancy");
  const channelRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "channels")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(channelRows, [
    "ChannelApp",
    "ChannelAppThread",
    "ChannelConnection",
    "ChannelEventInbox",
    "ChannelInstallation",
    "ChannelThread",
  ]);
  // WIN-258 T5: `conversations` IS delegated now — the NINTH owner — and the
  // grant is exactly the FOUR rows ADR M0.3 §1 row 16 gives it. The note that
  // stood here said it was NOT delegated, which was why `channels`' harness
  // seeds the `Thread` its link rows point at as SQL; that harness is unchanged
  // and stays unchanged, because this entry moves no owner TAG and a `Thread`
  // written from `channels-links.ts` is still refused.
  assert.equal(CANONICAL_STORE_ADAPTERS.conversations, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("conversations"), [
    "packages/contexts/conversations",
    "packages/adapters/postgres-tenancy",
  ]);
  const conversationRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "conversations")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(conversationRows, ["PostmanExecution", "Step", "Thread", "Turn"]);
  // WIN-258 T5: `files` is the THIRTEENTH context delegated to that same
  // directory, and the grant is exactly the TWO rows ADR M0.3 §1 row 10 gives
  // it. Pinned as a SET rather than a count, for the reason `tools`' ten are.
  assert.equal(CANONICAL_STORE_ADAPTERS.files, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("files"), [
    "packages/contexts/files",
    "packages/adapters/postgres-tenancy",
  ]);
  const filesRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "files")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(filesRows, ["Artifact", "MessageAttachment"]);
  // AND THE UNDELEGATED NEGATIVE MOVES ON AGAIN, to `jobs`. It carried
  // `conversations`' turn and then `files`', and the shape of the proof has not
  // changed: `AgentApproval` hangs off a `Thread` this directory writes, `Job`
  // is a row in the very same PostgreSQL database reachable through the very
  // same client, and a write to either from here is still refused. Adjacency in
  // the schema is not permission.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, undefined);
  assert.deepEqual(ownerDirectories("jobs"), ["packages/contexts/jobs"]);

  // WIN-258 T4: the outbox pseudo-owner is delegated to that SAME directory.
  // Its primary directory is an ADAPTER rather than a context — the one owner in
  // the map for which that is true — and the note that used to sit beside this
  // entry said it therefore needed no delegation. That was true of the directory
  // and false of the write: `packages/adapters/outbox` may not hold the ORM, so
  // without this grant the row owned by the outbox adapter was owned by a
  // package unable to write it.
  assert.deepEqual(ownerDirectories("<kernel-outbox-adapter>"), [
    "packages/adapters/outbox",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(
    CANONICAL_STORE_ADAPTERS["<kernel-outbox-adapter>"],
    "packages/adapters/postgres-tenancy",
  );
  // And the grant is exactly TWO rows wide, not a licence over the schema:
  // `Event` and the superseded `ObservabilityOutbox`. Every other row still
  // resolves to its own owner's directories.
  const outboxRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "<kernel-outbox-adapter>")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(outboxRows, ["Event", "ObservabilityOutbox"]);
  // WIN-258 T5: `tools` is delegated to that SAME directory, for the fourth
  // time and on the same sentence — one PostgreSQL database behind one client
  // is one adapter DIRECTORY (ADR M0.3 §15).
  assert.deepEqual(ownerDirectories("tools"), [
    "packages/contexts/tools",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.tools, "packages/adapters/postgres-tenancy");
  // And the grant is exactly TEN rows wide — ADR M0.3 §1 row 7 — not a licence
  // over the schema. Pinned as a SET rather than a count, because a count is
  // satisfied by any ten rows and the point of the entry is WHICH ten.
  const toolsRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "tools")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(toolsRows, [
    "AgentToolPolicy",
    "EntityMcpClient",
    "EntityMcpConfig",
    "EntityToolPolicy",
    "EnvironmentEntityTool",
    "OrganizationMcpPolicy",
    "Tool",
    "ToolCall",
    "ToolCallAudit",
    "ToolHealth",
  ]);
  // WIN-258 T5: `governance` is delegated to that SAME directory, the SIXTH
  // owner to be, and the grant is exactly the FIVE rows ADR M0.3 §1 row 14 gives
  // it. Pinned as a SET rather than a count, because a count is satisfied by any
  // five rows and the point of the entry is WHICH five.
  assert.deepEqual(ownerDirectories("governance"), [
    "packages/contexts/governance",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.governance, "packages/adapters/postgres-tenancy");
  const governanceRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "governance")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(governanceRows, [
    "AgentEval",
    "EvalCriterion",
    "GoldenSet",
    "MessageRating",
    "SafetyEvent",
  ]);
  // And the rows `governance` READS through its inverted read-seam ports are
  // NOT in the grant. `Turn` and `Thread` are `conversations`', and three of
  // these five tables hang off one -- so the entry that lets this directory
  // write an eval still does not let it write the conversation the eval scored.
  //
  // WIN-258 T5 CHANGED WHAT THAT SENTENCE RESTS ON AND NOT WHETHER IT IS TRUE.
  // `conversations` is delegated to this same directory now, so `Thread` and
  // `Turn` ARE writable from it — but not by `governance`'s entry, which is the
  // whole point. The grant is per OWNER and the owner TAG is read per write, so
  // the case below asks the question directly rather than through the absence of
  // a map entry that is no longer absent: a write to `Thread` attributed to
  // `governance`'s directory-and-context pair is refused, because the pair
  // permitted to write it is `conversations`'.
  assert.equal(CANONICAL_STORE_ADAPTERS.conversations, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("conversations"), [
    "packages/contexts/conversations",
    "packages/adapters/postgres-tenancy",
  ]);
  for (const [delegate, model] of [
    ["thread", "Thread"],
    ["turn", "Turn"],
  ]) {
    const trespass = checkWriteEnforcement(
      fixture({
        [`packages/contexts/governance/application/x.ts`]: write(delegate, "create"),
      }),
    );
    assert.equal(trespass.violations.length, 1, `a governance write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.deepEqual(trespass.violations[0].permitted, [
      "packages/contexts/conversations",
      "packages/adapters/postgres-tenancy",
    ]);
  }
});

test("a THIRD directory writing a `tools` row is refused, and the refusal names it", () => {
  // The delegation above is only meaningful if it is NARROW. This is the RED
  // case for it: the same statement, on the same row, from a directory that is
  // neither `packages/contexts/tools` nor its one delegate. Without this case
  // the entry in `CANONICAL_STORE_ADAPTERS` is indistinguishable from a blanket
  // licence, because every write the live tree makes is already legal.
  const root = fixture({
    // A context that is NOT tools, writing tools' row through the ORM.
    "packages/contexts/agents/application/steal.ts":
      `export async function run(db: any) {\n  await db.toolCall.create({ data: {} });\n}\n`,
    // And an ADAPTER that is not the delegate, writing another of the ten raw.
    "packages/adapters/redis-ratelimit/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.$executeRaw\`insert into "public"."Tool" (id) values ('x')\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.violations.length, 2, "both writes must be refused, not just the ORM one");
  const byModel = Object.fromEntries(result.violations.map((v) => [v.model, v]));
  assert.deepEqual(Object.keys(byModel).sort(), ["Tool", "ToolCall"]);
  // The refusal has to say WHERE the write may live, and both permitted
  // directories are named — the context and its one delegate.
  assert.deepEqual(byModel.ToolCall.permitted, [
    "packages/contexts/tools",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(byModel.Tool.permitted, byModel.ToolCall.permitted);
  assert.match(byModel.ToolCall.message, /tools is its sole writer/);
  assert.match(byModel.Tool.message, /tools is its sole writer/);
  // And it has to name the directory that actually wrote it, or a reader cannot
  // find the offending line.
  assert.equal(byModel.ToolCall.actual, "packages/contexts/agents");
  assert.equal(byModel.Tool.actual, "packages/adapters/redis-ratelimit");
});

test("the SAME writes from the delegate directory are permitted", () => {
  // The control for the case above. Same two statements, same two rows, moved
  // into the one directory the map grants — and now there is no violation at
  // all. Without this the RED case could be passing because the harness refuses
  // everything rather than because the delegation is narrow.
  const root = fixture({
    "packages/adapters/postgres-tenancy/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.toolCall.create({ data: {} });\n` +
      `  await db.$executeRaw\`insert into "public"."Tool" (id) values ('x')\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 2);
});

// ---------------------------------------------------------------------------
// Map-integrity failures must themselves fail.
// ---------------------------------------------------------------------------

test("map integrity fails when the schema gains a model with no owner", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma":
      `model User {\n  id String @id\n}\n\nmodel BrandNewRow {\n  id String @id\n}\n`,
  });
  // Owner directories are read from the real tree, so only the schema differs.
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("UNOWNED BrandNewRow")),
    "a new canonical row without an owner must fail",
  );
});

test("map integrity fails when an owned model leaves the schema", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma": `model User {\n  id String @id\n}\n`,
  });
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("PHANTOM Organization")),
    "an owner for a row that no longer exists must fail",
  );
});

test("map integrity fails when a row recorded as absent reappears in the schema", () => {
  const root = fixture({
    "internal-packages/tenancy-database/prisma/schema.prisma":
      `model SecretReference {\n  id String @id\n}\n`,
  });
  const result = checkMapIntegrity(root);
  assert.ok(
    result.problems.some((problem) => problem.startsWith("RESOLVED SecretReference")),
    "a resurrected row must be given an owner rather than staying recorded as absent",
  );
});
