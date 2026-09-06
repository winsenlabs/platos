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

  // THE OLD WITNESS IS GONE AND SAYING SO IS THE POINT. This case used to name a
  // canonical row the shared directory could NOT write — `Memory`, then
  // `Artifact`, then `Job` — and every tranche delegated the owner that name
  // belonged to. This wave delegated the last five, so all ninety-three owned
  // rows are writable from here and a name left in place would make the case
  // green while asserting its opposite.
  //
  // WHAT "NOTHING ELSE" NOW MEANS, AND STILL HAS TEETH: not any row from any
  // directory, and not any table at all. A THIRD directory writing `Job` is
  // refused with `jobs` named as its sole writer, and a table no owner claims is
  // UNATTRIBUTABLE from this directory rather than permitted — which is what
  // stops a new table being written from here before it has an owner.
  const elsewhere = checkWriteEnforcement(
    fixture({ "packages/adapters/redis-cache/src/c.ts": write("job", "deleteMany") }),
  );
  assert.equal(elsewhere.violations.length, 1);
  assert.equal(elsewhere.violations[0].model, "Job");
  assert.match(elsewhere.violations[0].message, /jobs is its sole writer/u);

  const unowned = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/d.ts": 'db.$executeRaw`DELETE FROM "WorkflowRun"`;',
    }),
  );
  assert.deepEqual(unowned.violations, []);
  assert.equal(unowned.unattributable.length, 1, "an unowned table must not be silently permitted here");
  assert.equal(unowned.unattributable[0].reason, "raw-sql-unknown-table");
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
  // WIN-258 T5 MOVED THIS EXAMPLE TWICE AND THEN RETIRED IT, and the retirement
  // is itself the finding. `EnvironmentSkill` used to stand here, because
  // `skills` had no entry in `CANONICAL_STORE_ADAPTERS` and this directory
  // therefore could not write it; then `Artifact`, then `Job`. All three are
  // delegated to this SAME directory now, so each of those writes is legal and
  // the gate judges the DIRECTORY. That is the exact consequence Amendment 15
  // chose and it is stated rather than papered over.
  //
  // WHAT STILL HOLDS is that ownership is carried by the TAG on the row: the
  // same write from a THIRD directory is refused, and the refusal names the
  // owner rather than the folder the file happens to sit in.
  const refused = fixture({
    "packages/adapters/notifier-webhook/src/agents-y.ts": write("job", "create"),
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
  // And `memory` is the TWELFTH, `privacy` the THIRTEENTH, `jobs` the
  // FOURTEENTH, `files` the FIFTEENTH, `observability` the SIXTEENTH and
  // `eventing` the SEVENTEENTH — which is EVERY owner the table names.
  assert.deepEqual(ownerDirectories("memory"), [
    "packages/contexts/memory",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("privacy"), [
    "packages/contexts/privacy",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(ownerDirectories("files"), [
    "packages/contexts/files",
    "packages/adapters/postgres-tenancy",
  ]);
  // And `observability` is the SIXTEENTH. It is the entry that most needs
  // stating, because this owner also DRAINS two rows it is deliberately not the
  // writer of: `ownerDirectories("<kernel-outbox-adapter>")` is a different
  // pair, and no part of this grant reaches it.
  assert.deepEqual(ownerDirectories("observability"), [
    "packages/contexts/observability",
    "packages/adapters/postgres-tenancy",
  ]);
  // THIS WAVE COMPLETED THE MAP, AND THAT FALSIFIED THE SECOND HALF OF THIS
  // CASE rather than shortening it. Every revision before this one kept a list
  // of owners with NO entry, and each tranche moved a name out of it and left
  // the rest. There is no name left: `privacy`, `jobs`, `files`,
  // `observability` and `eventing` were the last five, and all five are
  // delegated here. A list that still named one would be asserting something
  // false, and a list that named a context this repository does not have would
  // be asserting nothing.
  //
  // THE PROPERTY IS THE FUNCTION'S RATHER THAN ANY OWNER'S, so it is proven
  // both ways instead. Positively, over every owner the table names — including
  // the outbox pseudo-owner, whose primary directory is an ADAPTER and not a
  // context — because "all seventeen contexts and the kernel outbox resolve to
  // the one directory" is the claim this wave actually makes, and no earlier
  // revision of this case could have made it.
  for (const owner of owners()) {
    assert.deepEqual(ownerDirectories(owner), [
      ownerDirectory(owner),
      "packages/adapters/postgres-tenancy",
    ]);
  }
  // And negatively, on a name the map deliberately does not carry: the
  // undelegated arm still answers ONE directory, so the shared directory stays
  // a grant made per owner rather than a licence the map has merely stopped
  // withholding. This is the arm `checkSoleWriter` takes for any owner a future
  // context adds before its store exists.
  assert.equal(CANONICAL_STORE_ADAPTERS["unlanded-context"], undefined);
  assert.deepEqual(ownerDirectories("unlanded-context"), ["packages/contexts/unlanded-context"]);
});

test("§15: the delegation map is COMPLETE, and that is now a positive claim", () => {
  // Stated on its own so the completion is visible in a failure message rather
  // than inferred from the loop above. An owner added without a store entry
  // turns this red, which is the shape the previous revision could only express
  // as "the undelegated list still has somebody in it".
  assert.deepEqual(
    owners().filter((owner) => CANONICAL_STORE_ADAPTERS[owner] === undefined),
    [],
  );
  assert.equal(owners().length, 18);
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

  // And the widening did not licence a CONTEXT over rows it does not own, which
  // is where the boundary now sits. The branch used `Thread` here, then
  // `Artifact`, then `AgentApproval`, and this wave delegated the last of them —
  // so from the shared DIRECTORY every owned row is legal and the witness had to
  // move to a directory rather than to another row. `packages/contexts/memory`
  // is that directory: it may write its own three rows and `AgentApproval` is
  // `jobs`' (§1 row 15), which `MemoryRepository` never touches. A WRITE to it
  // from there is refused, which is what makes "reads are unrestricted" a
  // bounded statement rather than an open door.
  const readOnlyPeers = checkWriteEnforcement(
    fixture({
      "packages/contexts/memory/application/memory-y.ts": write("agentApproval", "update"),
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

test("only observability's own two directories may write `AdminAudit`", () => {
  // WIN-258 T5. The delegation added in this tranche is a permission, and a
  // permission is only worth anything if the thing it does NOT permit goes red.
  // ONE row rather than a list, because ADR M0.3 §1 row 12 gives this context
  // exactly one Prisma model: its four analytical tables are not Prisma rows at
  // all and are reached through `ObservabilitySink`.

  // The delegate directory: legal, and the reason the repository can exist at
  // all — ADR M0.3 §2 forbids `packages/contexts/observability` from holding the
  // client.
  assert.deepEqual(
    checkWriteEnforcement(
      fixture({ "packages/adapters/postgres-tenancy/src/x.ts": write("adminAudit", "create") }),
    ).violations,
    [],
    "AdminAudit must be writable from its canonical-store adapter",
  );
  // The owning context itself: also legal, and never exercised in the live tree
  // for exactly that reason.
  assert.deepEqual(
    checkWriteEnforcement(
      fixture({ "packages/contexts/observability/application/x.ts": write("adminAudit", "create") }),
    ).violations,
    [],
    "AdminAudit must be writable from its owning context",
  );

  // ANY THIRD PLACE: refused. `tenancy` is the pointed choice — every admin
  // action this table records is a change to an organization, a project or an
  // environment, and it is the context most plausibly tempted to append its own
  // evidence — and it is exactly as refused as anything else, even though it is
  // delegated to the SAME directory for its own rows.
  const trespass = checkWriteEnforcement(
    fixture({ "packages/contexts/tenancy/application/x.ts": write("adminAudit", "create") }),
  );
  assert.equal(trespass.violations.length, 1, "a foreign write to AdminAudit must be refused");
  assert.equal(trespass.violations[0].model, "AdminAudit");
  assert.equal(trespass.violations[0].actual, "packages/contexts/tenancy");
  assert.deepEqual(trespass.violations[0].permitted, [
    "packages/contexts/observability",
    "packages/adapters/postgres-tenancy",
  ]);

  // And a SIBLING canonical-store adapter is not a loophole either: being an
  // adapter is not the qualification, being THIS owner's declared store is. The
  // outbox adapter is the pointed choice here, because `observability` is the
  // context that DRAINS the outbox — the two are as close as two packages in
  // this tree get, and the grant still does not cross.
  assert.equal(
    checkWriteEnforcement(
      fixture({ "packages/adapters/outbox/src/x.ts": write("adminAudit", "create") }),
    ).violations.length,
    1,
    "AdminAudit must be refused from an adapter that is not its canonical store",
  );

  // AND THE CONVERSE, WHICH MATTERS MORE FOR THIS OWNER THAN FOR ANY OTHER.
  // `observability` DRAINS `ObservabilityOutbox` and `Event` and is deliberately
  // NOT their writer: ADR M0.3 §1's closing note and §7 decision 8 give both to
  // the kernel outbox adapter's pseudo-owner. A write to either from an
  // `observability`-tagged module in this directory is still refused, which is
  // what keeps "this context settles the envelope" and "this context does not
  // write the queue row" both true.
  for (const [delegate, model] of [
    ["observabilityOutbox", "ObservabilityOutbox"],
    ["event", "Event"],
  ]) {
    const drained = checkWriteEnforcement(
      fixture({ "packages/contexts/observability/application/drain.ts": write(delegate, "create") }),
    );
    assert.equal(drained.violations.length, 1, `${model} must be refused from observability`);
    assert.equal(drained.violations[0].model, model);
    assert.equal(drained.violations[0].expected, "packages/adapters/outbox");
  }

  // And the widening did not licence a CONTEXT over rows it does not own.
  // `ErasureOperation` is `privacy`'s (§1 row 18) — the context that
  // ORCHESTRATES the erasure this store's unlink is part of, and the one whose
  // rows a careless implementation of `clearAdminAuditActor` would reach for.
  // This wave delegated `privacy` to the SAME directory this store sits in, so
  // the witness is `packages/contexts/observability` rather than that directory:
  // a WRITE to `ErasureOperation` from there is refused, which is what makes
  // "reads are unrestricted" a bounded statement rather than an open door.
  const readOnlyPeers = checkWriteEnforcement(
    fixture({
      "packages/contexts/observability/application/observability-y.ts": write("erasureOperation", "update"),
    }),
  );
  assert.equal(readOnlyPeers.violations.length, 1);
  assert.equal(readOnlyPeers.violations[0].model, "ErasureOperation");
  assert.equal(readOnlyPeers.violations[0].expected, "packages/contexts/privacy");
});

test("the RAW `INSERT INTO \"AdminAudit\"` a suite plants is attributed to `observability`", () => {
  // The append-only rule means two rows the constraints suite needs — an ARRAY
  // snapshot the narrower CHECK refuses, and a row with no `source` — cannot be
  // produced by any path through the port. They are planted as raw SQL, in the
  // ONE directory now permitted to write the table, and they are judged by the
  // table they name rather than exempted for being raw.
  const permitted = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/observability-constraints.integration.test.ts":
        'await db.$executeRawUnsafe(`INSERT INTO "AdminAudit" ("id") VALUES (\'x\')`);\n',
    }),
  );
  assert.deepEqual(permitted.violations, []);
  assert.equal(permitted.writeCount, 1, "the raw write must be SEEN, not merely un-flagged");

  const trespass = checkWriteEnforcement(
    fixture({
      "packages/contexts/privacy/application/x.ts":
        'await db.$executeRawUnsafe(`INSERT INTO "AdminAudit" ("id") VALUES (\'x\')`);\n',
    }),
  );
  assert.equal(trespass.violations.length, 1);
  assert.equal(trespass.violations[0].model, "AdminAudit");
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
  // THIS WAVE EMPTIED THE OLD FORM OF THIS CASE, and replacing it is the point
  // rather than a repair. Every revision before this one named two CANONICAL
  // ROWS the shared directory could not write and watched them refused —
  // `Memory`, then `Turn`, then `Artifact`, then `ErasureOperation`, then
  // `AgentApproval` — and each tranche delegated the owner that name belonged
  // to. There is no name left: all seventeen contexts and the kernel outbox
  // resolve to this directory now, so every one of the ninety-three owned rows
  // is legally writable from it, and a pair named here would make the case pass
  // while asserting the opposite of what its title says.
  //
  // WHAT REPLACES IT IS THE HALF THAT STILL HAS TEETH: the licence is over the
  // OWNED ROWS OF ONE SCHEMA, not over whatever a file in this directory can
  // reach. A statement naming a table the canonical set does not carry is
  // UNATTRIBUTABLE from here — the gate fails on it rather than permitting it —
  // which is what stops a table being written from this directory before it has
  // an owner at all, and `durable-runtime`'s vendor schema is exactly such a
  // table (ADR M0.3 §7 decision 10 encapsulates that database whole).
  const stranger = checkWriteEnforcement(
    fixture({
      "packages/adapters/postgres-tenancy/src/x.ts":
        'db.$executeRaw`UPDATE "WorkflowRun" SET "x" = 1`;',
    }),
  );
  assert.deepEqual(stranger.violations, []);
  assert.equal(stranger.unattributable.length, 1, "an unowned table must not be silently permitted here");
  assert.equal(stranger.unattributable[0].reason, "raw-sql-unknown-table");
  assert.equal(stranger.unattributable[0].actual, "packages/adapters/postgres-tenancy");

  // AND THE GRANT IS STILL PER OWNER RATHER THAN PER DIRECTORY, which is the
  // property the old form was really testing. `AgentApproval` is `jobs`' and
  // `ErasureOperation` is `privacy`'; both are delegated to the shared directory
  // and to NO OTHER adapter, so a sibling adapter writing either is refused with
  // the two permitted directories named. `redis-cache` is the pointed choice:
  // `ADAPTER_BINDINGS` gives it a port whose owner is `memory`, and holding a
  // port is not holding another owner's rows.
  for (const [delegate, model] of [
    ["agentApproval", "AgentApproval"],
    ["erasureOperation", "ErasureOperation"],
  ]) {
    const trespass = checkWriteEnforcement(
      fixture({ "packages/adapters/redis-cache/src/x.ts": write(delegate, "create") }),
    );
    assert.equal(trespass.violations.length, 1, `${model} must be refused from an adapter that is not its store`);
    assert.equal(trespass.violations[0].model, model);
    assert.deepEqual(trespass.violations[0].permitted, [
      `packages/contexts/${OWNER[model]}`,
      "packages/adapters/postgres-tenancy",
    ]);
    // And the SAME write from the delegate directory is permitted, so the
    // refusal above is about the directory and not about the row.
    assert.deepEqual(
      checkWriteEnforcement(
        fixture({ "packages/adapters/postgres-tenancy/src/x.ts": write(delegate, "create") }),
      ).violations,
      [],
    );
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
// WIN-258 T5 — THE `privacy` CANONICAL STORE adds SIX, three per table, and the
// interesting thing about the list is how SHORT it is for a context whose whole
// job is destruction. Every DELETE an erasure performs is issued by the context
// that owns the row, through the kernel's `ErasureTarget`; this store writes only
// the record of what those deletes did, and the barrier that keeps the subject
// from coming back. Each line was read back from the enforcer rather than counted
// by eye:
//
//   src/privacy-operations.ts   erasureOperation.createManyAndReturn (the row
//                               `request-erasure.ts` opens), .updateManyAndReturn
//                               (one pass's progress, identity columns absent
//                               from `data` by construction) and the .updateMany
//                               whose WHERE carries the free-lease predicate —
//                               the compare-and-set the port requires to be ONE
//                               statement                                       3
//   src/privacy-tombstones.ts   erasureTombstone.createMany (seal), .updateMany
//                               (extend) and .deleteMany (the retention sweep).
//                               THREE and not four: the port's insert-then-extend
//                               rule forbids a delete-then-insert, so there is no
//                               delete on the seal path at all and the only
//                               DELETE here cannot match a live row            3
//                                                                        total = 6
//
// ITS SUITES CONTRIBUTE ZERO, and the reason is the same one every tranche above
// gives with one addition. `privacy-constraints.integration.test.ts` plants rows
// this store REFUSES to write — a `stores` whose JSON root is an object, a
// `status` outside the enum — through `prisma db execute`, the ORM's own CLI,
// which is runtime and out of this scanner's scope by construction; writing them
// through this package's delegate would be writing them through the guard under
// test. And `privacy-harness.ts` needs exactly ONE peer row, `Organization`,
// which it obtains by CALLING the tenancy repository already in this directory —
// so that statement is counted once, at its own source, among the 12.
//
//
// WIN-258 T5 — THE `jobs` CANONICAL STORE adds EIGHT, the narrowest store in
// this directory because the context owns the fewest rows in the map — two:
//
//   src/jobs-definitions.ts    job.createManyAndReturn, the updateMany behind
//                              `updateJob`, the SECOND updateMany behind
//                              `markStarted` — guarded on `status: "ACTIVE"`
//                              and resolved through `atomic()` because the
//                              port carries no token — and deleteMany         4
//   src/jobs-approvals.ts      agentApproval.createManyAndReturn, the guarded
//                              `updateMany({ where: { status: "PENDING" } })`
//                              that makes a second decision land on nothing,
//                              and the updateMany behind `markConsumed`       3
//   src/jobs-erasure.ts        one deleteMany. Nothing holds a foreign key TO
//                              an approval, so this single statement IS the
//                              erasure and its count is the receipt's         1
//                                                                        total = 8
//
// Its SIX suites contribute ZERO between them. `jobs-conformance`,
// `-constraints`, `-transaction` and `-statements` write every row they need
// through the ports under measurement, because `Job` and `AgentApproval` are now
// this directory's to write. `jobs-harness.ts` and
// `jobs-rules.integration.test.ts` seed the ancestry an approval hangs off —
// `Agent`, `Thread`, `Turn` — and plant the rows this store REFUSES to write,
// and both do it through `prisma db execute`, which is the ORM's CLI at runtime
// and not a client call at all, so the scanner neither sees them nor should.
//
//
// WIN-258 T5 — THE `observability` CANONICAL STORE adds FIVE, and THREE of them
// are in SUITES rather than in the store, which has not been true of any tranche
// before it:
//
//   src/observability-audit.ts     `adminAudit.create`, and the `updateMany`
//                                  the append-only rule refuses. The second is
//                                  SENT deliberately — see the file's header —
//                                  so the refusal comes from the database
//                                  rather than from this package's memory of
//                                  having read the migration                   2
//   src/observability-constraints  `adminAudit.delete`, proving the rule covers
//     .integration.test.ts         DELETE as well as UPDATE, and TWO raw
//                                  `INSERT INTO "AdminAudit"` statements that
//                                  plant rows no path through the port can
//                                  produce — an ARRAY snapshot the narrower
//                                  CHECK refuses, and a row with no `source`.
//                                  Each spells its SQL AT THE CALL SITE, so
//                                  `MUTATING_SQL_STATEMENT` attributes it by
//                                  the TABLE it names                          3
//                                                                        total = 5
//
// `src/observability-harness.ts` contributes ZERO and needs no out-of-band seed
// at all, which is a fact about the TABLE rather than about the harness:
// `AdminAudit` has exactly one foreign key, to `Environment`, and its
// `actorUserId` is a plain nullable TEXT column with no relation — so nothing it
// points at belongs to a context this directory may not write.
//
//
// WIN-258 TRANCHE 5, `eventing` adds ELEVEN, all from the SAME directory and all
// on the ONE row its owner holds — with one deliberate exception named below.
// Each line was read back from the enforcer rather than counted by eye:
//
//   src/eventing-rules.ts       notificationRule.create, .updateManyAndReturn
//                               and .deleteMany. The two PLURAL forms are not a
//                               style: `update` and `delete` RAISE P2025 when
//                               nothing matched, and a raise inside the caller's
//                               transaction aborts it, so a rule addressed in
//                               the wrong scope would cost the caller its whole
//                               unit of work instead of returning the refusal
//                               the port describes                              3
//   src/eventing-erasure.ts     the raw `UPDATE "NotificationRule" ... FROM
//                               "Environment" JOIN "Project"` that scrubs
//                               `createdBy` WITHOUT moving `updatedAt`. There is
//                               no delegate form of that write: the column is
//                               `@updatedAt`, so every `updateMany` stamps it,
//                               and the domain — not the client — owns that
//                               value. `MUTATING_SQL_STATEMENT` attributes the
//                               statement by the TABLE it names                 1
//   src/eventing-constraints.integration.test.ts
//                               FOUR writes standing each guard beside the
//                               constraint it restates: two `create` calls
//                               issued through the CLIENT rather than the port
//                               (the `@db.Uuid` control and the NUL-byte
//                               control, both of which must be seen to be
//                               refused by the DATABASE and not only by the
//                               guard), and two raw INSERTs that put a JSON
//                               ARRAY into `filters` and a JSON STRING into
//                               `delivery` — the two `*_json_root` CHECKs, which
//                               no port call can reach                          4
//   src/eventing-rules.integration.test.ts
//                               THREE: two raw INSERTs proving the unique index
//                               and the absent `updatedAt` default refuse a
//                               writer that bypasses the port, and ONE
//                               `DELETE FROM "Environment"` — a row `tenancy`
//                               owns, legal from here ONLY because `tenancy`
//                               resolves to this same directory, and the one
//                               write in this tranche that is not on
//                               `NotificationRule`                              3
//                                                                       total = 11
//
// `src/eventing-harness.ts` CONTRIBUTES ZERO and that is the interesting half.
// Its tenant tree goes through `saveOrganization`, `saveProject` and
// `saveEnvironment` — `tenancy`'s ports, in this directory — and its
// `applyRows` is a STRING handed to `prisma db execute`, not a call to
// `$executeRaw`, so the four rows the rules suite plants (a `filters` with no
// `eventTypes`, a `delivery` outside the union, a 200-character name, a row with
// no `enabled`) are invisible to this scanner and should be: they are the ORM's
// CLI at runtime rather than a client call at all.
// `src/eventing-conformance.integration.test.ts`,
// `src/eventing-transaction.integration.test.ts` and
// `src/eventing-statements.integration.test.ts` contribute zero for the simpler
// reason: every row they need is written through the port under measurement.
//
//
// 12 + 51 + 3 + 3 + 17 + 27 + 37 + 7 + 13 + 28 + 17 + 30 + 6 + 15 + 6 + 8 + 5 + 5
// + 11 = 301. All of tranche 5's stores landed in the ONE directory, so this
// pin is the SUM of every enumeration above and no single branch's own figure
// survives the merge.
//
// WIN-258 TRANCHE 7 MOVES IT BY SIX, AND ONLY ITS CONCURRENCY AND POOLING
// DIMENSION DOES. That dimension reported no delta here at all, so this gate was
// not in its list; the merged scan is where it is first counted, and the six are
// enumerated rather than absorbed. The other three dimensions add ZERO: a census
// module, a measurement kit, five plan suites, a rollout harness and their
// suites READ, and a `select:` that narrows a read is not a mutation.
//
//   src/secrets-variables.ts    NET +1. The single `upsert` behind
//                               `setEnvironmentVariable` becomes TWO writes: a
//                               `createManyAndReturn` with `skipDuplicates`
//                               (ON CONFLICT DO NOTHING, because a caught 23505
//                               aborts the enclosing transaction and the COMMIT
//                               after it then reports success while discarding
//                               everything) and an `update` carrying
//                               `expectedVersion` in its WHERE clause beside the
//                               compound unique, so the precondition and the
//                               write are ONE statement. 2 - 1                 1
//   src/optimistic-concurrency.integration.test.ts
//                               ONE raw UPDATE on `EnvironmentVariable`: the
//                               UNFENCED read-modify-write reproduced out of
//                               band, which is what proves the fence refuses
//                               something a writer can otherwise commit         1
//   src/pooling.integration.test.ts
//                               TWO raw INSERTs on `Organization` — a row
//                               `tenancy` owns, legal from here only because
//                               `tenancy` resolves to this same directory. They
//                               are raw because the point is a statement the
//                               SERVER cancels or a backend it terminates, which
//                               no port call is shaped to produce               2
//   src/transaction-boundaries.integration.test.ts
//                               TWO `create` calls on `EnvironmentVariable`,
//                               issued through the CLIENT rather than the port,
//                               because what is under measurement is whether the
//                               row is there on a SECOND connection after the
//                               unit of work resolved                           2
//                                                                       total = 6
//
// 301 + 6 = 307. Every one of the six is inside
// `packages/adapters/postgres-tenancy`, which is the permitted directory for
// both `EnvironmentVariable` and `Organization`, so the violation list stays
// empty and it is the COUNT that moved — which is exactly what this pin is for.
//
// WIN-259 (M2.4) MOVES IT BY FOUR, ALL IN ONE NEW FILE:
//
//   src/secrets-legacy-envelope.integration.test.ts
//                               FOUR raw INSERTs on `CredentialSecretVersion` —
//                               a row `secrets` owns, legal from here because
//                               `secrets` resolves to this same directory. THREE
//                               are expected to be REFUSED by the migrations'
//                               `octet_length` and `rootKeyVersion` CHECKs, which
//                               is the whole point of the suite: a legacy
//                               envelope is unstorable, so the migration must
//                               transcode rather than update in place. The
//                               FOURTH is the control that runs the same
//                               statement with a canonical shape and succeeds,
//                               without which the three refusals could be
//                               failing for an unrelated reason.
//
//                               They are RAW because the repository port cannot
//                               express them. `insertSecretVersion` takes a
//                               `CredentialSecretVersionDraft`, whose salt and
//                               nonce are typed `Uint8Array` with no width and
//                               whose `rootKeyVersion` is a branded positive
//                               integer — so a zero-length salt, a 16-byte nonce
//                               and a root key version of 0 are values the PORT
//                               refuses to carry. The only way to ask PostgreSQL
//                               the question is to go around the port, and a
//                               statement the port cannot express is exactly
//                               what `sole-writer` counts rather than forbids.  4
//                                                                       total = 4
//
// 307 + 4 = 311. All four are inside `packages/adapters/postgres-tenancy`, the
// permitted directory for `CredentialSecretVersion` since WIN-258 T5 gave
// `secrets` its `CANONICAL_STORE_ADAPTERS` entry, so the violation list stays
// empty and it is again the COUNT that moved.
const LIVE_TREE_WRITE_COUNT = 311;

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
  // NO OWNER CARRIES THAT NEGATIVE ANY MORE, and stating it is better than
  // faking it. `jobs` stood here after `files` was delegated; this wave
  // delegates `jobs` too, and with it the last five, so every owner in the map
  // has a store and the "one permitted directory" arm is unreachable from the
  // map. The arm itself is still there and is proven on a name the map does not
  // carry, in the `ownerDirectories` case above; what is asserted here is the
  // positive that replaced it — the grant is per OWNER, so `redis-ratelimit`
  // being identity-access's and `notifier-email` being cost-monitoring's still
  // buys neither of them a row.
  assert.equal(CANONICAL_STORE_ADAPTERS["redis-ratelimit"], undefined);
  assert.equal(CANONICAL_STORE_ADAPTERS["notifier-email"], undefined);
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
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
  // the grant is exactly the THREE rows ADR M0.3 §1 row 6 gives it.
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
  // WIN-258 T5. The SIXTEENTH owner delegated to the SAME directory, over the
  // ONE Prisma row ADR M0.3 §1 row 12 gives it. `files` was the absent name that
  // kept this a per-owner grant rather than a blanket one; this wave delegates it
  // too, so what is asserted here is the grant's WIDTH instead — one Prisma row,
  // not the five §1 credits the context with, because four of those are the
  // analytical projections `clickhouse-observability` holds.
  assert.equal(CANONICAL_STORE_ADAPTERS.observability, "packages/adapters/postgres-tenancy");
  assert.equal(CANONICAL_STORE_ADAPTERS.files, "packages/adapters/postgres-tenancy");
  assert.deepEqual(
    Object.entries(OWNER)
      .filter(([, owner]) => owner === "observability")
      .map(([model]) => model)
      .sort(),
    ["AdminAudit"],
  );
  const skillRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "skills")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(skillRows, ["EnvironmentSkill", "ProjectSkill", "Skill"]);
  // AND THE UNDELEGATED NEGATIVE HAS RUN OUT OF NAMES, which is what completing
  // §1 means. It was `skills` in the `providers` half of this case, `providers`
  // in the `skills` half, then `files`, then `jobs` — each right alone and wrong
  // once the next tranche landed. This wave grants the last five, so the boundary
  // is stated the only way that is still true: the grant is exactly the rows the
  // owner owns, read from `OWNER` rather than from the count.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(
    Object.entries(OWNER)
      .filter(([, owner]) => owner === "jobs")
      .map(([model]) => model)
      .sort(),
    ["AgentApproval", "Job"],
  );
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
  // WIN-258 T5: `files` is the FIFTEENTH context delegated to that same
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
  // AND THE UNDELEGATED NEGATIVE HAS NO NAME LEFT TO MOVE TO. It carried
  // `conversations`' turn, then `files`', then `jobs`', and this wave delegates
  // the last of them — so the proof changes shape rather than witness: the grant
  // is per OWNER, and `jobs` gets exactly the two rows `OWNER` tags `jobs`.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);

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
  // WIN-258 T5: `eventing` is the SEVENTEENTH and LAST owner delegated to that directory,
  // and the grant is exactly the ONE row ADR M0.3 §1 row 17 gives it that exists
  // in the canonical schema. It is the SMALLEST grant in the map, and the set is
  // pinned rather than the count for the same reason every other one is: a count
  // of one is satisfied by ANY row.
  assert.deepEqual(ownerDirectories("eventing"), [
    "packages/contexts/eventing",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.equal(CANONICAL_STORE_ADAPTERS.eventing, "packages/adapters/postgres-tenancy");
  const eventingRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "eventing")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(eventingRows, ["NotificationRule"]);
  // And the OTHER TWO rows ADR §1 row 17 names are still unowned, which is what
  // keeps the grant honest: `PlatformNotification` and
  // `PlatformNotificationInteraction` exist only in the legacy schema, so this
  // entry could not have granted them however it was written.
  assert.equal(OWNER.PlatformNotification, undefined);
  assert.equal(OWNER.PlatformNotificationInteraction, undefined);
  assert.equal(UNOWNED_ADR_ROWS.PlatformNotification, "legacy schema only; not a canonical tenancy row");
  // The row this context READS most and owns least is `Event`: the outbox
  // envelope it routes belongs to the pseudo-owner, and this grant moves nothing
  // about it. A write to `Event` tagged `eventing` is refused from here exactly
  // as it is from anywhere else.
  const eventTrespass = checkWriteEnforcement(
    fixture({
      "packages/contexts/eventing/application/x.ts": write("event", "create"),
    }),
  );
  assert.equal(eventTrespass.violations.length, 1);
  assert.equal(eventTrespass.violations[0].model, "Event");
  assert.deepEqual(eventTrespass.violations[0].permitted, [
    "packages/adapters/outbox",
    "packages/adapters/postgres-tenancy",
  ]);
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

test("only privacy's own two directories may write its two rows, and a third goes RED", () => {
  // WIN-258 T5. The delegation this tranche adds is a PERMISSION, and a
  // permission is only worth anything if the thing it does not permit goes red.
  // BOTH rows are checked rather than a representative one, because the grant is
  // per row and a map entry lost for a single model would otherwise sit here
  // unnoticed behind a green case for the other.
  //
  // THE TRESPASSER IS `conversations`, DELIBERATELY, and it is the sharpest
  // choice available. That context implements the kernel `ErasureTarget` this
  // context's pass invokes, is delegated to the SAME adapter directory, and runs
  // its own deletes inside the very `TransactionScope` this store's
  // `updateProgress` is written under. Every ingredient for "it is right there,
  // just write the receipt yourself" is present — and the gate refuses it,
  // because the receipt is `privacy`'s row and being invited into somebody's
  // transaction is not ownership of their table.
  for (const [delegate, model] of [
    ["erasureOperation", "ErasureOperation"],
    ["erasureTombstone", "ErasureTombstone"],
  ]) {
    const root = fixture({
      // A context that is NOT privacy, writing privacy's row through the ORM.
      "packages/contexts/conversations/application/steal.ts":
        `export async function run(db: any) {\n  await db.${delegate}.create({ data: {} });\n}\n`,
      // And an ADAPTER that is not the delegate, writing the same row raw.
      "packages/adapters/outbox/src/steal.ts":
        `export async function run(db: any) {\n` +
        `  await db.$executeRaw\`insert into "public"."${model}" (id) values ('x')\`;\n` +
        `}\n`,
    });
    const result = checkWriteEnforcement(root);
    assert.deepEqual(result.unattributable, []);
    assert.equal(result.violations.length, 2, `${model} must be refused from BOTH trespassers`);
    for (const violation of result.violations) {
      assert.equal(violation.model, model);
      // The refusal has to say WHERE the write may live, and both permitted
      // directories are named — the context and its one delegate.
      assert.deepEqual(violation.permitted, [
        "packages/contexts/privacy",
        "packages/adapters/postgres-tenancy",
      ]);
      assert.match(violation.message, /privacy is its sole writer/);
    }
    // And it has to name the directory that actually wrote it, or a reader
    // cannot find the offending line.
    assert.deepEqual(
      result.violations.map((violation) => violation.actual).sort(),
      ["packages/adapters/outbox", "packages/contexts/conversations"],
    );
  }
});

test("the SAME privacy writes from the delegate directory are permitted, and the grant is TWO rows wide", () => {
  // The control for the case above. Same two rows, same two forms — a delegate
  // call and a raw statement — moved into the one directory the map grants, and
  // now there is no violation at all. Without this the RED case could be passing
  // because the harness refuses everything rather than because the delegation is
  // narrow and real.
  const root = fixture({
    "packages/adapters/postgres-tenancy/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.erasureOperation.create({ data: {} });\n` +
      `  await db.$executeRaw\`insert into "public"."ErasureTombstone" (id) values ('x')\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 2, "both writes must be SEEN, or the green is vacuous");

  // And the grant is exactly TWO rows wide, not a licence over the schema.
  // Pinned as a SET rather than a count, because a count is satisfied by any two
  // rows and the point of the entry is WHICH two.
  assert.equal(CANONICAL_STORE_ADAPTERS.privacy, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("privacy"), [
    "packages/contexts/privacy",
    "packages/adapters/postgres-tenancy",
  ]);
  const privacyRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "privacy")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(privacyRows, ["ErasureOperation", "ErasureTombstone"]);
  // The NEGATIVE that keeps this from reading as "the directory may write
  // anything a sweep touches". An erasure DELETES `Memory`, `Turn` and
  // `MessageAttachment`, and every one of those deletes is issued by the context
  // that owns the row through the kernel's `ErasureTarget`.
  //
  // THE WITNESS MOVED WHEN THIS WAVE LANDED `files`. The privacy branch asserted
  // `CANONICAL_STORE_ADAPTERS.files === undefined` and refused the write on a
  // ONE-directory grant; `files` is delegated now, so that assertion is false and
  // carrying it would have made this case green while stating the opposite. What
  // is still true — and is the property the case was really about — is that
  // `privacy`'s OWN context directory may not write another owner's row, however
  // central that row is to the sweep it runs.
  assert.equal(CANONICAL_STORE_ADAPTERS.files, "packages/adapters/postgres-tenancy");
  const refused = checkWriteEnforcement(
    fixture({
      "packages/contexts/privacy/application/steal.ts":
        `export async function run(db: any) {\n  await db.messageAttachment.deleteMany({});\n}\n`,
    }),
  );
  assert.equal(refused.violations.length, 1);
  assert.equal(refused.violations[0].model, "MessageAttachment");
  assert.deepEqual(refused.violations[0].permitted, [
    "packages/contexts/files",
    "packages/adapters/postgres-tenancy",
  ]);
});

test("§15: `jobs` is delegated to that same directory, and the grant is TWO rows wide", () => {
  // The FOURTEENTH owner. `Job` and `AgentApproval` are in the one PostgreSQL
  // database behind the one client, so ADR M0.3 §15 puts them in this directory
  // rather than in a thirteenth adapter package holding a second client.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
  const jobRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "jobs")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(jobRows, ["AgentApproval", "Job"]);
  // AND THE NEGATIVE IS THE ANCESTRY AN APPROVAL HANGS OFF. `AgentApproval`
  // carries foreign keys to `Agent`, `Thread` and `Turn`, and
  // `enforce_domain_ancestry` re-reads all three from inside its own INSERT —
  // so this is the store in the directory with the strongest reason to reach
  // for a row it does not own, and it may not. All three ARE writable from this
  // directory, under `agents`' and `conversations`' tags, from their own
  // stores; the tag is what decides, not the folder.
  for (const [delegate, model, owner] of [
    ["agent", "Agent", "agents"],
    ["thread", "Thread", "conversations"],
    ["turn", "Turn", "conversations"],
  ]) {
    const trespass = checkWriteEnforcement(
      fixture({
        "packages/contexts/jobs/application/x.ts": write(delegate, "create"),
      }),
    );
    assert.equal(trespass.violations.length, 1, `a jobs write to ${model} must be refused`);
    assert.equal(trespass.violations[0].model, model);
    assert.deepEqual(trespass.violations[0].permitted, [
      `packages/contexts/${owner}`,
      "packages/adapters/postgres-tenancy",
    ]);
  }
});

test("a THIRD directory writing a `jobs` row is refused, and the refusal names it", () => {
  // The RED case the `jobs` entry needs to be a narrow grant rather than a
  // blanket licence: the same two statements, on the same two rows, from a
  // directory that is neither `packages/contexts/jobs` nor its one delegate.
  // Every write the live tree makes is already legal, so without this case the
  // entry would be indistinguishable from a licence over the schema.
  const root = fixture({
    // A context that is NOT jobs, writing a job through the ORM.
    "packages/contexts/agents/application/steal.ts":
      `export async function run(db: any) {\n  await db.job.create({ data: {} });\n}\n`,
    // And an ADAPTER that is not the delegate, writing the other row raw.
    "packages/adapters/redis-cache/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.$executeRaw\`insert into "public"."AgentApproval" (id) values ('x')\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.violations.length, 2, "both writes must be refused, not just the ORM one");
  const byModel = Object.fromEntries(result.violations.map((v) => [v.model, v]));
  assert.deepEqual(Object.keys(byModel).sort(), ["AgentApproval", "Job"]);
  assert.deepEqual(byModel.Job.permitted, [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
  assert.deepEqual(byModel.AgentApproval.permitted, byModel.Job.permitted);
  assert.match(byModel.Job.message, /jobs is its sole writer/);
  assert.match(byModel.AgentApproval.message, /jobs is its sole writer/);
  // And it has to name the directory that actually wrote it, or a reader cannot
  // find the offending line.
  assert.equal(byModel.Job.actual, "packages/contexts/agents");
  assert.equal(byModel.AgentApproval.actual, "packages/adapters/redis-cache");
});

test("the SAME `jobs` writes from the delegate directory are permitted", () => {
  // The control for the case above. Same two statements, same two rows, moved
  // into the one directory the map grants — and now there is no violation at
  // all. Without this the RED case could be passing because the harness refuses
  // everything rather than because the delegation is narrow.
  const root = fixture({
    "packages/adapters/postgres-tenancy/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.job.create({ data: {} });\n` +
      `  await db.$executeRaw\`insert into "public"."AgentApproval" (id) values ('x')\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 2, "both writes must be SEEN, or the green is vacuous");

  // And the grant is exactly TWO rows wide, not a licence over the schema.
  // Pinned as a SET rather than a count, because a count is satisfied by any
  // two rows and the point of the entry is WHICH two.
  assert.equal(CANONICAL_STORE_ADAPTERS.jobs, "packages/adapters/postgres-tenancy");
  assert.deepEqual(ownerDirectories("jobs"), [
    "packages/contexts/jobs",
    "packages/adapters/postgres-tenancy",
  ]);
  const jobsRows = Object.entries(OWNER)
    .filter(([, owner]) => owner === "jobs")
    .map(([model]) => model)
    .sort();
  assert.deepEqual(jobsRows, ["AgentApproval", "Job"]);
  // The NEGATIVE that keeps this from reading as "the directory may write
  // anything an approval hangs off". `enforce_domain_ancestry` re-reads
  // `Agent`, `Thread` and `Turn` from inside this store's own INSERT, and all
  // three belong to other owners — so a write to one of them from
  // `packages/contexts/jobs` is refused with that owner's two directories
  // named. The tag decides, not the folder.
  const refused = checkWriteEnforcement(
    fixture({
      "packages/contexts/jobs/application/steal.ts":
        `export async function run(db: any) {\n  await db.thread.deleteMany({});\n}\n`,
    }),
  );
  assert.equal(refused.violations.length, 1);
  assert.equal(refused.violations[0].model, "Thread");
  assert.deepEqual(refused.violations[0].permitted, [
    "packages/contexts/conversations",
    "packages/adapters/postgres-tenancy",
  ]);
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

test("a THIRD directory writing `eventing`'s ONE row is refused, and the refusal names it", () => {
  // The narrowness proof for the smallest grant in the map. A one-row
  // delegation is the easiest to mistake for a blanket licence, because every
  // write the live tree makes on that row is already legal — so this is the same
  // statement, on the same row, from two directories that are neither
  // `packages/contexts/eventing` nor its one delegate.
  const root = fixture({
    // A context that is NOT eventing, writing eventing's row through the ORM.
    "packages/contexts/governance/application/steal.ts":
      `export async function run(db: any) {\n  await db.notificationRule.updateMany({ data: {} });\n}\n`,
    // And an ADAPTER that is not the delegate, writing it raw.
    "packages/adapters/redis-streams/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.$executeRaw\`update "public"."NotificationRule" set "enabled" = false\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.violations.length, 2, "both writes must be refused, not just the ORM one");
  for (const violation of result.violations) {
    assert.equal(violation.model, "NotificationRule");
    assert.deepEqual(violation.permitted, [
      "packages/contexts/eventing",
      "packages/adapters/postgres-tenancy",
    ]);
    assert.match(violation.message, /eventing is its sole writer/);
  }
  // And it has to name the directory that actually wrote it, or a reader cannot
  // find the offending line.
  assert.deepEqual(
    result.violations.map((violation) => violation.actual).sort(),
    ["packages/adapters/redis-streams", "packages/contexts/governance"],
  );
});

test("the SAME two writes from the delegate directory are permitted", () => {
  // The control for the case above. Without it the RED case could be passing
  // because the harness refuses everything rather than because the delegation is
  // narrow.
  const root = fixture({
    "packages/adapters/postgres-tenancy/src/steal.ts":
      `export async function run(db: any) {\n` +
      `  await db.notificationRule.updateMany({ data: {} });\n` +
      `  await db.$executeRaw\`update "public"."NotificationRule" set "enabled" = false\`;\n` +
      `}\n`,
  });
  const result = checkWriteEnforcement(root);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unattributable, []);
  assert.equal(result.writeCount, 2);
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
