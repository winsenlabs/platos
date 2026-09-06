p = "scripts/arch/sole-writer.test.mjs"
s = open(p).read()

# 1. the two-directories case: governance moves out of the undelegated list.
old = '''  assert.deepEqual(ownerDirectories("cost-monitoring"), [
    "packages/contexts/cost-monitoring",
    "packages/adapters/postgres-tenancy",
  ]);
  for (const owner of ["memory", "secrets", "governance", "files"]) {
    assert.deepEqual(ownerDirectories(owner), [`packages/contexts/${owner}`]);
  }
});'''
new = '''  assert.deepEqual(ownerDirectories("cost-monitoring"), [
    "packages/contexts/cost-monitoring",
    "packages/adapters/postgres-tenancy",
  ]);
  // WIN-258 T5. `governance` moved from the undelegated list below to this one;
  // the list it left still has to contain somebody, or the case stops saying
  // anything.
  assert.deepEqual(ownerDirectories("governance"), [
    "packages/contexts/governance",
    "packages/adapters/postgres-tenancy",
  ]);
  for (const owner of ["memory", "secrets", "files"]) {
    assert.deepEqual(ownerDirectories(owner), [`packages/contexts/${owner}`]);
  }
});'''
assert old in s, "two-directories case"
s = s.replace(old, new)

# 2. the write-count pin.
old = '''// 12 + 51 + 3 + 3 + 17 + 27 + 37 = 150. All THREE tranche-5 stores landed in
// the one directory, so the pin is the SUM of the three enumerations above and
// no branch's own figure — 86, 96 or 106 — survives the merge.
const LIVE_TREE_WRITE_COUNT = 150;'''
new = '''// WIN-258 TRANCHE 5, `governance` adds 13, all from the SAME directory and all
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
// 12 + 51 + 3 + 3 + 17 + 27 + 37 + 13 = 163. All FOUR tranche-5 stores landed in
// the one directory, so the pin is the SUM of the four enumerations above and
// no branch's own figure survives the merge.
const LIVE_TREE_WRITE_COUNT = 163;'''
assert old in s, "write count"
s = s.replace(old, new)

# 3. the grant is exactly five rows wide, in the delegation case.
old = '''  assert.deepEqual(toolsRows, [
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
});'''
new = '''  assert.deepEqual(toolsRows, [
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
  assert.equal(CANONICAL_STORE_ADAPTERS.conversations, undefined);
  assert.deepEqual(ownerDirectories("conversations"), ["packages/contexts/conversations"]);
});'''
assert old in s, "tools rows"
s = s.replace(old, new)

open(p, "w").write(s)
print("patched sole-writer.test.mjs")
