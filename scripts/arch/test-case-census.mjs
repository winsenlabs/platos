#!/usr/bin/env node
// Owner decision 9 (2026-09-02) — the per-package test CASE census.
//
// WHY THIS EXISTS. `docs/v1-ledger-rules.json` pins test FILE counts
// (`packages.contexts.test: 64`, `packages.kernel.test: 3`), so deleting a whole
// test file goes red. Deleting `it()` blocks INSIDE a retained file was
// invisible to every gate in `.github/workflows/ci.yml`: `test:v1-packages`
// prints "716 passed" and passes just as happily at 700. Finding 6 of the
// 2026-09-02 independent verification put it plainly — "716 is evidence, not a
// canary" — and the owner decided the case count is pinned, not only the file
// count. Everything else in this programme pins its census; this was the hole.
//
//   node scripts/arch/test-case-census.mjs          # check, exit 1 on drift
//   node scripts/arch/test-case-census.mjs --json   # machine-readable
//
// WHAT A "CASE" IS. A call to `it()` or `test()` in a `*.test.ts` file under a
// V1 package, counted on the AST so a name in a string or a comment is not a
// case. `it.each([a, b, c])(...)` counts as THREE, because that is what vitest
// reports, and pinning the declaration site instead would let two thirds of a
// table be deleted silently.
//
// IT REFUSES RATHER THAN GUESSES. The census is exact or it fails. Anything that
// makes the static count differ from the runtime count is a REFUSAL, reported
// with its file and line and failing the check:
//
//   * `it.each` over anything but an array literal, or as a tagged template —
//     the row count is not statically visible.
//   * `describe.each` — it multiplies every case inside it.
//   * a case declared inside a helper function, a loop, or any callback that is
//     not a `describe`/`suite` body — the site is one, the runtime count is not.
//
// That refusal list is what lets the pinned numbers below be the SAME numbers
// vitest prints, rather than a second, weaker census that happens to correlate.
//
// HONEST LIMITATIONS.
//   * It counts DECLARATIONS. A case that throws at collection time, a
//     `describe` skipped by a runtime condition, or a `test.skipIf` that is
//     false in CI still counts as one here. `nonExecuting` below is pinned at 0
//     precisely so none of those can arrive unnoticed.
//   * It reads `*.test.ts` only, matching what `test:v1-packages` runs. A
//     `.test.tsx`, `.spec.ts` or `__tests__/` convention would be invisible; the
//     file counts pinned here are the control on that.
//   * It says nothing about whether a case ASSERTS anything. Emptying an `it()`
//     body is not drift this gate can see. Mutation testing is the control for
//     that, and it is a separate discipline in this programme, not this file's.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** `packages/kernel` is a package; the other two are directories OF packages. */
export const PACKAGE_ROOTS = Object.freeze(["packages/kernel", "packages/contexts", "packages/adapters"]);

const TEST_FILE_SUFFIX = ".test.ts";
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "generated", "coverage"]);

/** Identifiers that declare a case, and the ones that only group. */
const CASE_ROOTS = new Set(["it", "test"]);
const GROUP_ROOTS = new Set(["describe", "suite"]);

/** Chain members that expand one declaration site into many runtime cases. */
const EXPANDING_MODIFIERS = new Set(["each", "for"]);

/** Chain members that stop a declared case from executing. */
const NON_EXECUTING_MODIFIERS = new Set(["skip", "todo"]);

/**
 * The pinned census. One row per V1 package, zeros included: a package that
 * gains its first test must be declared here, so "a new context arrived with no
 * suite" and "a suite was deleted" are the same kind of failure.
 *
 * DELTAS AGAINST `3ed8f3ce972289908a7d129bbb682e977405770f`, the head the
 * 2026-09-02 independent verification reproduced. It recorded 716 cases across
 * 67 files, split kernel 44, identity-access 231, secrets 162, tenancy 146,
 * files 133. This census reproduces that split exactly and carries TWO deltas:
 *
 *   files 133 -> 134 (+1), 716 -> 717 total. The storage-key separator case
 *   added to close MAJOR 2 of that verification —
 *   `packages/contexts/files/domain/storage-key.test.ts`, "is not fooled by a
 *   first segment that merely BEGINS with the attachment segment". Deleting the
 *   trailing "/" from `storageKeyBelongsToScope` left all 133 green; it now
 *   turns exactly this case red. File count is unchanged at 15 for `files`,
 *   which is precisely the drift a file-count pin cannot see and this one can.
 *
 * REBASE DELTA (2026-09-02), `tejas/win-256-providers-context` onto
 * `75ee484de252`. The providers context was built on `3ed8f3ce`, so it predates
 * this census and its row was still the 0/0 placeholder that the map deliberately
 * carries for every unbuilt package. Making it real moves ONE row:
 *
 *   providers 0 -> 21 files, 0 -> 283 cases; 717 -> 1000 total. 13 domain
 *   suites, 7 application suites and the contracts-barrel suite. The census
 *   REFUSED nothing in that tree, so its 283 is a statically exact count, and
 *   `pnpm --filter @platos/context-providers exec vitest run` prints the same
 *   pair — "Test Files 21 passed (21) / Tests 283 passed (283)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * No other package moved: the rebase touched no suite outside providers, and
 * `files` stays at the 134 that closed MAJOR 2.
 *
 * EVENTING DELTA — 0 -> 14 files / 0 -> 142 cases, 1000 -> 1142 total. WIN-256
 * made the seventeenth context real: `NotificationRule`, the outbox drain that
 * evaluates it, and the `NotificationRequested` it emits. The suite is weighted
 * towards the rules lifted out of
 * `apps/agent/src/mcp-platform/events.service.ts`, because those are the ones a
 * reader would "tidy up" without realising they are load-bearing — the event
 * matcher's bare-prefix arm, its segment anchor, "an empty eventTypes array
 * matches nothing", the three-send retry ceiling, and the weak legacy email
 * rule.
 *
 * THIRD DELTA — `eventing` 142 -> 147 cases, 1142 -> 1147 total. File count
 * stays at 14: all five cases went into existing files, which is exactly the
 * drift a file-count pin cannot see. They close what the 2026-09-03 independent
 * verification found, and each was confirmed by watching a named mutation turn
 * it red:
 *
 *   +3 `application/route-observed-event.test.ts` — the drain-boundary
 *      `reparse` guard was ENTIRELY DEAD to the suite. Deleting its filter arm,
 *      deleting its destination arm, and swapping its two skip reasons all left
 *      142/142 green.
 *   +1 `application/register-notification-rule.test.ts` — the duplicate-name
 *      pre-flight. The in-memory store enforces the unique index too, so the
 *      error code alone could not tell "pre-flighted" from "refused by the
 *      store"; the new case pins that no transaction is opened.
 *   +1 `application/eventing-erasure-target.test.ts` — a plan carrying this
 *      target's own name but no subject rider. The existing foreign-plan case
 *      only exercised the targetName half of `isEventingErasurePlan`.
 *
 * THE MUTATION CLAIM IS NOW ENUMERATED. The commit that introduced this context
 * said "12 semantic mutations applied, all 12 killed" and this comment said
 * "eighteen"; neither listed one, the two numbers disagreed, and neither was
 * reproducible. That claim is withdrawn. The replacement is a 43-mutation set
 * enumerated line by line in the commit message, each with its file, its exact
 * edit and its verdict: 41 KILLED, and ONE argued equivalent-mutant PAIR in
 * `assertNameFree` whose two halves masked each other. The two mutations this
 * census exists to catch remain the pattern matcher's segment anchor and the
 * retry off-by-one, each of which leaves every other case in the package green.
 *
 * FOURTH DELTA — `eventing` 147 -> 149 cases, 1147 -> 1149 total. File count
 * again UNCHANGED at 14. The two survivors above were re-run on the rebase onto
 * `95cbacc1` and both reproduced exactly: delete the same-name shortcut, 147/147
 * green; delete the id-inequality test, 147/147 green. "The pair defends it" is
 * a statement about the SUITE, though, and the docblock over `assertNameFree`
 * was making a stronger claim than that — it gave each line its own distinct
 * reason to exist and neither reason had a control. Both are now pinned, and
 * both survivors are killed:
 *
 *   +1 "re-PUTting the rule's OWN name costs no lookup at all" — asserts on the
 *      store's recorded name lookups, because the shortcut's only observable
 *      effect is the query it avoids; the RESULT is identical without it.
 *      Deleting `|| edit.name === rule.name` now turns this red.
 *   +1 "does NOT report a conflict when the clashing row is the rule's OWN,
 *      renamed concurrently" — drives the stale-read interleaving the id test
 *      exists for through the double's new `beforeFindRuleByName` hook, which
 *      is unreachable from a store that only ever answers from a settled state.
 *      Deleting `&& clash.value.ruleId !== rule.ruleId` now turns this red.
 *
 * The eventing mutation result is therefore 43 of 43 KILLED, with no argued
 * equivalence left standing.
 *
 * SKILLS ADOPTION (WIN-256, M2.1). `packages/contexts/skills` goes from a
 * generator placeholder to a real context and carries the second delta:
 *
 *   skills 0 -> 302 cases across 0 -> 20 files; 1000 -> 1302 total. Ten domain
 *   suites (manifest parse and its YAML subset, the catalogue identity and its
 *   ordering, visibility, the install pair, prompt composition, tool
 *   namespacing, environment readiness, category derivation, import-source
 *   rewriting), nine application suites (register, import, install, bind,
 *   compose-runtime, run-tool, seed, read-catalogue, erasure target) and one
 *   contract suite exercising the published surface alone.
 *
 *   Eleven semantic mutations were applied to this context's own source and all
 *   eleven were killed; the two narrowest kills are the budget boundary
 *   (`>` to `>=` in `composeSkills`, caught only by the exactly-fills-the-budget
 *   case) and the gate ordering in `bindSkill` (moving the readiness check after
 *   the write, caught only by "does NOT leave a materialised install behind").
 *
 * VERIFICATION DELTA (2026-09-03) — skills 302 -> 306 cases, 1302 -> 1306 total.
 * FILE count unchanged at 20: all four cases went into an existing suite, which
 * is exactly the drift a file-count pin cannot see and this one can.
 *
 * The "eleven, all killed" claim above is superseded rather than deleted, so the
 * two can be compared. The rebase onto `95cbacc1` re-ran a 25-mutation set over
 * this context's guards — visibility and the organization conjunct, both halves
 * of the install-enabled conjunction, the readiness gate at bind and at run,
 * protocol admission, the three host-rewrite rules, the sandbox preconditions,
 * all four erasure decisions, the prompt budget boundary. FOUR SURVIVED, and
 * every one of them was a security boundary:
 *
 *   SK11/SK13/SK14  each `hostname !==` guard in domain/import-source.ts
 *                   relaxed to `!hostname.endsWith(...)`. All three left 302/302
 *                   green. "Every rule is guarded by exact hostname equality" is
 *                   the sentence that module's header rests its HOST CLOSURE
 *                   argument on — and the reason it gives for the submitted URL
 *                   needing no address check of its own — and nothing tested it.
 *                   The suite had a PREFIX look-alike only. +4 cases supplying
 *                   SUFFIX look-alikes; each rule's relaxation is now red.
 *   SK19            the `isToolOfSkill` pre-check in `resolveDispatchedTool`.
 *                   Deleted rather than covered: it is a PROVABLY equivalent
 *                   mutant, not a coverage gap. `namespaceTool` always emits the
 *                   slug's prefix plus the separator, so the loop beneath it
 *                   accepts exactly the names the pre-check admits and rejects
 *                   exactly the ones it refuses. No test can distinguish the two
 *                   versions. It was also a prefix-split shortcut sitting above
 *                   a comment explaining why that function does not split
 *                   prefixes. The property stays pinned by the existing "REFUSES
 *                   a name belonging to a different skill".
 *
 * Re-run after both changes: 24 of 24 applicable mutations KILLED, SK19's anchor
 * gone with the line.
 *
 * M2 WAVE-B INTEGRATION — THE ADOPTIONS ARE SUMMED, NEVER SIDE-PICKED.
 * `eventing`, `skills`, `jobs`, `memory`, `cost-monitoring`, `privacy`,
 * `observability` and `agents` touch DISJOINT packages and each moves this same runtime total on its own axis, so
 * the
 * integrated number is the sum of every delta and is correct on no branch
 * alone:
 *
 *   717   the five slice-1-5 packages (kernel 44, identity-access 231,
 *         secrets 162, tenancy 146, files 134).
 *   +283  providers (21 files).
 *   +149  eventing (14 files) — 142 at adoption, 147 after the 2026-09-03
 *         verification's five cases, 149 after the two that kill its last two
 *         argued equivalent-mutant survivors, all with the file count at 14.
 *   +306  skills (20 files) — 302 at adoption, 306 after the four host-closure
 *         cases the re-run mutation sweep forced, with the file count at 20.
 *
 *   +378  jobs (16 files) — 350 at adoption, then 354, 367 and 378 as three
 *         successive independent verifications forced cases into EXISTING
 *         files, with the file count at 16 throughout.
 *   +605  memory (28 files) — 602 at adoption, 605 after the three cases the
 *         published-erasure-target review forced, again with the file count
 *         held at 28.
 *
 *   +352  cost-monitoring (21 files) — 335 at adoption, 345 after the ten
 *         money-path cases the v1 rebase review forced and 352 after the seven
 *         the 2026-09-03 re-check forced, with the file count held at 21.
 *
 *   +254  privacy (15 files) — 240 at adoption, 252 after the twelve cases the
 *         2026-09-03 verification's surviving mutants forced and 254 after the
 *         two the 2026-09-04 erasure-path re-check forced, with the file count
 *         held at 15 throughout.
 *
 *   +288  observability (15 files) — 281 at the source branch tip, 287 after the
 *         six money-path cases the v1 rebase forced (five of them in the NEW
 *         drain-projections.lanes.test.ts, which is why 14 files became 15) and
 *         288 after the pricing-rates case of 2026-09-04, which landed in that
 *         same new file and moved no file count. NO production module changed
 *         for any of them.
 *
 *   +515  agents (25 files) — 513 at adoption, 517 after the four releaseHolds
 *         cases the 2026-09-03 verification forced, and 515 after the
 *         2026-09-04 blocker closure. THAT LAST MOVE IS NEGATIVE, and it is the
 *         one worth reading twice: 517 - 3 - 1 + 2 = 515. The DELETIONS are
 *         written separately from the ADDITION so a deletion cannot hide inside
 *         an addition and reach the same total —
 *           -3  domain/agent.ts::slugIsTaken, deleted WITH its only cases
 *           -1  authorization.ts::projectOf, deleted WITH its only case
 *           +2  the two "even the disambiguated slug is taken" guards, which
 *               had no cases at all
 *         domain/cluster.ts::clusterSlugIsTaken was the third unwired guard and
 *         was WIRED rather than deleted, so its own cases are unchanged and it
 *         is deliberately NOT a term above. The file count is 25 throughout all
 *         three moves.
 *
 *   717 + 283 + 149 + 306 + 378 + 605 + 352 + 254 + 288 + 515 = 3847, and
 *   88 + 14 + 20 + 16 + 28 + 21 + 15 + 15 + 25 = 242 files.
 *
 * The eventing branch pinned 1149, the skills branch pinned 1306, the jobs
 * branch pinned 1378, the memory branch pinned 1605, the cost-monitoring branch
 * pinned 1352, the privacy branch pinned 1254, the observability branch pinned
 * 1288 and the agents branch pinned 1515; each was right for its own tree and
 * wrong for this one.
 * Picking any of them would silently drop a whole context's suite out of the
 * pinned total while the census stayed green on the branch it came from — which
 * is precisely the drift this constant exists to catch. The skills branch
 * pinned 1019 (717 + 302) before its rebase onto the providers commit, for the
 * same reason.
 *
 * JOBS ADOPTION (WIN-256, ADR M0.3 §1 row 11). `packages/contexts/jobs`
 * becomes real, rebased onto v1 @ `95cbacc1`:
 *
 *   jobs 0 -> 350 across 0 -> 16 files, 1000 -> 1350 total. WIN-256 made
 *   `packages/contexts/jobs` real: two aggregates (`Job`, `AgentApproval`), the
 *   execution-request admission gate, the idempotent execute path, and the
 *   approval suspend/resume seam ADR M0.3 §1 names for this context. The split
 *   is domain 253 across 10 files and application+contracts 97 across 6.
 *   `jobs` was pinned at 0/0 as an undeclared context, so this is the first
 *   non-zero pin for it rather than a movement of an existing one.
 *
 *   jobs 350 -> 354 (+4), 1350 -> 1354 total, file count UNCHANGED at 16. The
 *   2026-09-03 independent verification of the jobs branch found two surviving
 *   mutants, and these four cases are exactly the ones that kill them. Both were
 *   reproduced as controls before the cases were written, and each was watched
 *   go red and then green again:
 *
 *     +3 in `application/jobs-erasure-target.test.ts` (17 -> 20). Nothing in the
 *     suite read `ErasurePlanItem.method`, so changing `planItem`'s
 *     `method: "delete"` to `"anonymize"` — a right-to-erasure correctness path,
 *     where anonymising an approval whose subject lives in `comment` and
 *     `arguments` free text is erasure theatre — left all 350 green. The three
 *     new cases pin the method on the counted plan, on the vacuous entity plan,
 *     and on the RECEIPT, which re-mints its items and can therefore disagree
 *     with the plan it carried out.
 *
 *     +1 in `domain/payload.test.ts` (44 -> 45). The depth cap had `much deeper
 *     refused` and `at the limit accepted` but nothing at limit+1, so
 *     `depth > maxDepth` -> `depth > maxDepth + 1` left all 44 green. maxDepth+1
 *     wrappers is the only nesting that separates the two predicates.
 *
 *   jobs 354 -> 367 (+13), 1354 -> 1367 total, file count STILL UNCHANGED at 16.
 *   The 2026-09-03 verification of the rebased branch found SIX more survivors
 *   and these thirteen cases kill them. Each landed in the suite that can REACH
 *   the mechanism rather than beside the module that defines it, which is why no
 *   new file appears — exactly the drift a file-count pin cannot see:
 *
 *     +7 in `contracts/jobs-contract.test.ts` (17 -> 24). Which projection
 *     `describeJob` returns (2 — swapping it to `toJobSourceView` published the
 *     handler source and type-checked); `markApprovalConsumed`'s not-found guard
 *     (2, including the cross-environment id); and `mcpActionLabel`, which had
 *     no caller anywhere and is now the contract's MCP default (3, including the
 *     refusal when neither an action nor a tool name is supplied).
 *
 *     +4 in `application/approval-lifecycle.test.ts` (30 -> 34). The loser of a
 *     concurrent decision (2 — the conditional write's refusal branch was dead,
 *     so the loser was told `ok` AND the parked run was resumed with its
 *     decision), and the per-row `retained` diagnostic channel (2).
 *
 *     +2 in `application/execute-job.test.ts` (28 -> 30). A cached failure must
 *     replay under its OWN code; only `kind: "failed"` had ever round-tripped,
 *     and that code is the literal the mutation hard-codes.
 *
 *   These are added cases in existing files, which is why `files` does not move
 *   — precisely the drift a file-count pin cannot see and the case pin can.
 *
 *   jobs 367 -> 378 (+11), 1367 -> 1378 total, file count STILL UNCHANGED at 16.
 *   The 2026-09-03 independent RE-CHECK of the rebased branch found three
 *   substantive survivors and these eleven cases kill them. Each was reproduced
 *   as a control first — the mutation applied, the suite watched go red, the
 *   mutation reverted, the suite watched go green:
 *
 *     +6 in `contracts/jobs-contract.test.ts` (24 -> 30). The binder applied the
 *     MCP timeout clamp to EVERY path: `genericApprovalTimeout` had zero callers
 *     while `approvalRequestFrom` hardcoded `mcpApprovalTimeout`, so a generic
 *     approval with no timeout got 3600 s instead of 300 s and a generic request
 *     for 5 s was clamped UP to 60 s. Both timeout paths are now pinned THROUGH
 *     the published binder, in both directions: hardcoding either clamp turns
 *     three of the six red.
 *
 *     +3 in `application/execute-job.test.ts` (30 -> 33). Two for `settle`'s
 *     fail-closed error-code filter, which nothing could reach — the only test
 *     that named a non-execution failure injected it into `findJob`, which fails
 *     at stage 1, before a reservation exists. One for `classify`'s 64 KB cap,
 *     whose only oversize fixture was a single 70,000-character string that
 *     `isAdmissibleJson` refuses first.
 *
 *     +2 in `domain/execution-request.test.ts` (29 -> 31). The same 64 KB cap at
 *     the OTHER wired site, `admitExecutionRequest`, plus the control that the
 *     same shape inside the cap is admitted — so the refusal is proved to come
 *     from the cap rather than from any other limit.
 *
 * No other package moved. Any further drift is a finding to report, not a
 * number to force.
 *
 * MEMORY ADOPTION (WIN-256, ADR M0.3 §1 row 8). One row moves:
 *
 *   memory 0 -> 28 files, 0 -> 602 cases; 1000 -> 1602 total. 15 domain suites,
 *   12 application suites and the contracts-barrel suite. The census REFUSED
 *   nothing in that tree, so its 602 is a statically exact count, and
 *   `pnpm --filter @platos/context-memory exec vitest run` prints the same pair
 *   — "Test Files 28 passed (28) / Tests 602 passed (602)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 *   Six of those 602 arrived with the `authorizeMutation` gate: a self-review
 *   found archive, restore, revise, forget, forget-many and forget-entity
 *   reaching the READ gate, which an operator's `metadata` grant passes, so a
 *   grant that may not mutate could destroy a row. The gate and its six cases
 *   landed together, and the mutations enumerated in that commit prove them a
 *   control rather than a claim.
 *
 *   The last SIX (596 -> 602) close the two defects the v1 rebase review named,
 *   and they add no file — 28 stays 28. Both were PROTECTIVE MECHANISMS THAT
 *   NOTHING PROVED PROTECTED, and both were confirmed by mutating the ORIGINAL
 *   596-case suite and watching it stay green:
 *
 *     +4 in application/authorization.test.ts. `subjectFor` takes the acting
 *        agent FROM the runtime grant and ignores the command's claim, but every
 *        existing case passed either null or the grant's own agent, so
 *        `request.actingAgentId ?? grant.runtime.actingAgentId` was invisible.
 *        Two cases now name a DIFFERENT agent at the unit, and two prove the
 *        consequence end to end — a denied cross-agent READ, and a write
 *        attributed to the grant's agent rather than the claimed one.
 *
 *     +2 in application/memory-erasure-target.test.ts. The receipt reports the
 *        counts the DELETES returned, but every existing case erased a store
 *        that had not moved since plan(), so `items: plan.items` — a forecast
 *        wearing an observation's clothes — passed. The store now moves between
 *        plan() and erase() in both directions.
 *
 *   memory 602 -> 605 (+3), 1602 -> 1605 total, and the file count STILL does
 *   not move — 28 stays 28. This is a NET of +9 and -6, which is the arithmetic
 *   a single number hides, so it is spelled out:
 *
 *     +6 in application/memory-erasure-target.test.ts (16 -> 22). Three of the
 *        target's six fail-closed branches were decorative. The two existing
 *        failure cases use a WHOLE-STORE outage, and the branches run in a fixed
 *        order, so an outage only ever reaches the first of them:
 *        `countMemoriesForSubject` on the plan path and
 *        `deleteRelationshipsForSubject` on the erase path. Neutralising
 *        `countEntitiesForSubject`'s refusal produced a ZERO-COUNT PLAN, and
 *        neutralising `deleteEntitiesForSubject`'s or
 *        `deleteMemoriesForSubject`'s produced a RECEIPT CARRYING THE PLAN'S
 *        COUNTS — exactly what `MemoryErasureRejected`'s docblock forbids — with
 *        all 602 green. `failErasureWith` on both in-memory doubles fails ONE
 *        method, so all six branches are now pinned independently.
 *
 *     +2 in contracts/index.test.ts (14 -> 16). `createMemoryErasureTarget` had
 *        no publication path at all: `MemoryContract` declared no
 *        `erasureTarget()`, the barrel re-exported no erasure symbol, and
 *        `package.json` publishes only this barrel and
 *        `application/ports/index.js`. The composition root could not obtain it,
 *        so `privacy`'s multi-context erasure silently omitted the sole writer
 *        of `Memory`, `MemoryEntity` and `MemoryRelationship`. It is published
 *        the way `files` publishes it on v1 and `jobs` in this same wave, and
 *        both cases go through the PUBLISHED BINDER so dropping the method again
 *        turns them red.
 *
 *     +1 in domain/content.test.ts (23 -> 24). `MAX_CONTENT_LENGTH`'s VALUE was
 *        unpinned: every case derived its input from the constant, so raising
 *        4000 to 4,000,000 stayed green. The literal is now the pin.
 *
 *     -6 in domain/authorization.test.ts (15 -> 9). `requireRuntimeAuthorization`
 *        (2 cases) and `verifyRuntimeScope` (4) are DELETED, with their tests.
 *        Both were dead: the former duplicates
 *        `application/authorization.ts::verifyRuntime` verbatim, and the latter
 *        has no possible caller, because `application/authorization.ts`'s own
 *        header records that "No use case in this package takes an environment
 *        id from a caller — the scope is derived from the grant", so there is no
 *        caller-supplied scope for it to compare against. A stable release does
 *        not ship a guard nothing can call beside the one that is called.
 *
 * Verified as a live control on the memory branch: deleting one `it()` from
 * `packages/contexts/memory/domain/fusion.test.ts` left the file count where it
 * was (116 there, 242 in this integrated tree) and turned the case count red,
 * which is the drift a file-count pin cannot see.
 *
 * COST-MONITORING ADOPTION (WIN-256, ADR M0.3 §1 row 13). One row again:
 *
 *   cost-monitoring 0 -> 21 files, 0 -> 345 cases; 1000 -> 1345 total. 12
 *   domain suites, 8 application suites and the contracts-barrel suite. The
 *   census REFUSED nothing in that tree, so its 345 is a statically exact
 *   count, and `pnpm --filter @platos/context-cost-monitoring exec vitest run`
 *   prints the same pair — "Test Files 21 passed (21) / Tests 345 passed
 *   (345)" — which is the agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 *   The last TEN (335 -> 345) close the three money-path survivors the v1
 *   rebase review named, and they add no file — 21 stays 21. Each was found by
 *   mutating the ORIGINAL 335-case suite and watching it stay green, and each
 *   is a MONEY figure that was reached but never asserted at an exact value:
 *
 *     +3 `settlePricedSpend` (application/consumption.test.ts). The step where
 *        a priced estimate becomes the settled truth had NO case at all. Both
 *        rules its own comment states — a pricing failure settles nothing
 *        rather than zero, and a ledger failure surfaces — could be deleted
 *        with the whole suite green.
 *
 *     +3 `limitToMoney` (domain/spend.test.ts). It appeared throughout that
 *        file as a way to BUILD a spend figure, never as the subject of an
 *        assertion, and always with a whole-cent cap — where truncating,
 *        rounding and flooring all agree. The cap is the other side of every
 *        money comparison in this context.
 *
 *     +4 `firstBlocker` and `runsBasisPoints` (domain/budget-status.test.ts).
 *        The blocker was only ever chosen among caps where `blocked` and
 *        `breached` agree, so selecting on `breached` — naming a cap the
 *        operator had explicitly excepted — passed. Turn utilisation was only
 *        ever asserted at the uncapped 0, which the early return produces
 *        without the arithmetic running at all.
 *
 *   cost-monitoring 345 -> 352 (+7), 1345 -> 1352 total, file count UNCHANGED at
 *   21. The 2026-09-03 independent RE-CHECK found two survivors and these seven
 *   cases kill them. Each mutation was reproduced as a control first: applied,
 *   the suite watched go red, reverted, watched go green.
 *
 *     +5 in application/deliver-crossing.test.ts. `targetFor` had NO test
 *        anywhere, and neither did the `target === null` check that reads it.
 *        The one case that reached `missing_configuration` reached it through
 *        the OTHER branch — no transport composed — so all four undeliverable
 *        answers were unfalsifiable. Each of the three refusals is now exercised
 *        with its transport COMPOSED, asserting both that the ledger records the
 *        code and that the transport was never called, plus a positive control
 *        so the four are not all passing on a `targetFor` that refuses
 *        everything.
 *
 *     +2 in application/detect-crossings.test.ts. "Both writes or neither" was
 *        not merely untested, it was UNTRUE — see the commit; a fan-out failure
 *        RETURNED an error from inside the unit of work, which resolves, which
 *        commits. The two cases pin the rollback and the retry it makes
 *        possible.
 *
 * Verified as a live control on the cost-monitoring branch: deleting one it()
 * from cost-monitoring/domain/guard.test.ts left the file count where it was
 * (109 there, 242 in this integrated tree) and turned the case count red, which
 * is the drift a file-count pin cannot see.
 *
 *
 * PRIVACY ADOPTION (WIN-256, ADR M0.3 §1 row 18). One row again:
 * `packages/contexts/privacy` goes 0 -> 15 files / 0 -> 254 cases, and the
 * INTEGRATED runtime total goes 2790 -> 3044. The privacy branch pinned
 * 1000 -> 1254 because its lineage carried only the four earliest packages: the
 * ROW is the same, the TOTAL it lands in is not, and that is exactly why this
 * census is reconciled by arithmetic and never by adopting a green branch total.
 * This is the whole of the new suite and nothing else
 * moved: right-to-erasure orchestration over the kernel `ErasureTarget[]`, the
 * erased-subject register that is the write barrier, the legal-hold
 * adjudication, the two status vocabularies and their lossy projection, and the
 * retry/lease schedule. The split is
 *
 *   domain/            118  alias 16, content-free 9, erasure-operation 27,
 *                           legal-hold 12, retry-schedule 15, target-outcome 27,
 *                           tombstone 12
 *   application/       112  guard-subject-write 21, inventory-subject 9,
 *                           request-erasure 28, retry-erasure 20,
 *                           run-erasure-pass 24, seal-subject 10
 *   application/testing 12  in-memory-privacy-repository
 *   contracts/          12  index
 *
 * 118 + 112 + 12 + 12 = 254, which is the pinned row and the number vitest
 * prints. The `domain/` subtotal read 123 when this delta was first written —
 * an addition error in the prose, not in the pin — so the stated split did not
 * reconcile to the number it was explaining. Corrected here; the per-file
 * figures beside it were right all along and are unchanged.
 *
 * Four of those 112 are the cases the FIRST mutation control added rather than
 * the first draft: two in `guard-subject-write` pinning that the barrier
 * re-applies read-time expiry instead of trusting its store, and two in
 * `request-erasure` pinning that a write landing MID-SWEEP is refused. TWELVE
 * MORE are the cases the 2026-09-03 independent verification's five surviving
 * mutants forced, and the file they landed in is the file that can reach the
 * guard rather than the file that defines it — which is why no new suite
 * appears and the file count stays 15:
 *
 *   request-erasure   +7  the `assertContentFree` wiring (2), an unsealed
 *                         subject is never swept (1), a transaction that never
 *                         opened leaves every target unknown (1), a refused
 *                         progress write is reported (1), `retainedRecords`
 *                         counts what a retention rule kept (2)
 *   run-erasure-pass  +2  the OTHER catch branch — a UnitOfWork that failed for
 *                         its own reasons carries no outcomes and must invent
 *                         one per planned target
 *   retry-erasure     +2  a refused progress write fails the retry and appends
 *                         no finished event
 *   seal-subject      +1  a store-refused seal is a failure, never a seal of 0
 *
 * Every one of those properties was claimed in a module header and survived its
 * mutation until these cases existed, which is the whole reason the control is
 * run. NO production module changed to close them: the guards were all present
 * and correct, and nothing executable reached any of them.
 *
 * TWO MORE, 2026-09-04, closing the three erasure-path blockers the 2026-09-03
 * verification left open. Both land in `retry-erasure`, so the file count is
 * still 15 and the arithmetic is 252 + 2 = 254, never a re-baseline:
 *
 *   retry-erasure     +2  the SAME handle, whose rows the first pass destroyed,
 *                         now resolving to NOBODY — the scenario the module
 *                         header describes and the one arrangement it had no
 *                         case for, because the only unresolved-subject case
 *                         supplied a handle that failed the NEXT guard too and
 *                         both guards then answered with one code (1); and the
 *                         retry-path RE-SEAL, which was prose alone — deleting
 *                         the `sealSubject` call left every case green (1)
 *
 * UNLIKE the twelve above, one production module DID change: the two guards were
 * given distinct codes (`PRIVACY_SUBJECT_NOT_RESOLVED` and the new
 * `PRIVACY_SUBJECT_MISMATCH`), and the refused event's label is now the returned
 * error's own `code` rather than a string written beside it — which is what
 * makes the mislabelled subject-mismatch refusal unrepresentable rather than
 * merely asserted against. Four existing cases gained refusal-label assertions;
 * gaining an assertion is not a case, so they move no number here.
 *
 * A package going 0 -> non-zero is exactly the transition this census exists to
 * force a reviewer to look at, which is why the zero rows are declared.
 *
 * No other package moved.
 * OBSERVABILITY ADOPTION (WIN-256, ADR M0.3 §1 row 16), from
 * `tejas/win-256-observability` @ 390f564f rebased onto v1 @ 95cbacc1. Another
 * 0/0 placeholder becomes real, and again exactly ONE row moves:
 *
 *   observability 0 -> 15 files, 0 -> 288 cases, and the INTEGRATED runtime
 *   total 3044 -> 3332. The observability branch pinned 1000 -> 1288 because its
 *   lineage carried only the four earliest packages; the ROW is the same and the
 *   TOTAL it lands in is not. 9 domain
 *   suites, 5 application suites and the contracts-barrel suite. The census
 *   REFUSED nothing in that tree, so its 288 is a statically exact count, and
 *   `pnpm --filter @platos/context-observability exec vitest run` prints the
 *   same pair — "Test Files 15 passed (15) / Tests 288 passed (288)".
 *
 * The source branch's own tip pinned observability at 14 files / 281 cases. The
 * difference is the six cases this rebase adds, all of them on the MONEY path:
 *
 *   +5 cases in the NEW file `application/drain-projections.lanes.test.ts`
 *   (14 -> 15 files) — the tool-call and usage lanes proven end to end from the
 *   queue to the sink, their conservation across one insert, and the two
 *   parking refusals. `readToolCall` and `readUsage` had ZERO coverage before
 *   them. The file is new rather than appended because those cases took
 *   drain-projections.test.ts past the 400-line warning band.
 *   +1 case in `contracts/observability-contract.test.ts` — the empty-lane
 *   control, which keeps "a Turn that called no tool" expressible now that the
 *   default fixture populates all four lanes.
 *
 * ONE MORE, 2026-09-04 (287 -> 288), closing the money-path blocker that
 * verification left open. It lands in the file the six above created, so the
 * file count does not move and the arithmetic is 281 + 6 + 1 = 288:
 *
 *   +1 case in `application/drain-projections.lanes.test.ts` — the PRICING
 *   RATES, end to end. `domain/observed-work-codec.ts::readRates` was reachable
 *   only through `readStep` and `readUsage` and no payload fixture carried a
 *   `rates` key, so it was only ever called with `undefined`: inserting
 *   `if (value !== null) return undefined;` at the top left 287 green.
 *   `domain/projection.ts::rateColumns` fills six columns from that read, so
 *   every step and usage row delivered from an envelope carried DEFAULT PRICES.
 *   `rateColumns` is covered through `testStep`, which is exactly what masked
 *   it. The fixture now carries rates on the step AND the usage event, and the
 *   case asserts `pricing_version` and the per-million columns on the SINK rows
 *   with exact values. NO production module changed.
 *
 * Every other package is unchanged.
 * AGENTS ADOPTION (WIN-256, ADR M0.3 §1 context 5). One row moves, and the
 * INTEGRATED runtime total goes 3332 -> 3847. The agents branch pinned
 * 1000 -> 1515 because its lineage carried only the four earliest packages; the
 * ROW is the same and the TOTAL it lands in is not.
 *
 *   agents 0 -> 25 files, 0 -> 513 cases at adoption. 14 domain suites,
 *   10 application suites and the contracts-barrel suite. The census REFUSED
 *   nothing in that tree, so its 513 is a statically exact count, and
 *   `pnpm --filter @platos/context-agents exec vitest run` prints the same pair
 *   — "Test Files 25 passed (25) / Tests 513 passed (513)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * Two of those 25 files exist because the ADR M0.3 §6 budget bit in the 400-line
 * warning band and the answer was to split rather than to waive; see the delta
 * comment in `scripts/arch/max-file-lines.test.mjs`.
 *
 * VERIFICATION DELTA (2026-09-03) — agents 513 -> 517 (+4), 1513 -> 1517 total.
 * File count is UNCHANGED at 25, which is exactly the drift a file-count pin
 * cannot see and this one can. The four cases all land in
 * `application/agent-write.test.ts` and all close ONE blocker: `removeAgent` was
 * the only one of the five `releaseHolds` call sites with no control, so its
 * call line could be deleted with all 513 cases green — a release that had a
 * caller but nothing asserting its effect.
 *
 *   1. "RELEASES every thread hold for the agent it just unbound" — seeds a
 *      hold, unbinds, and reads the lock back EMPTY. Deleting the call site
 *      turns it red.
 *   2. "releases NOTHING when the unbind was refused" — the unauthorised /
 *      invisible-agent input, asserting the holds survive.
 *   3. "releases NOTHING when the unbind transaction FAILED after starting" —
 *      the `if (removed.ok)` condition is a SECOND mechanism and dropping it
 *      left cases 1 and 2 green, because a `requireBound` refusal returns before
 *      the release line is reached at all. Reaching the guard needs a
 *      transaction that starts and then fails, which is why
 *      `InMemoryAgentsRepository.failNextDeleteBinding` was added.
 *   4. "leaves a hold on a DIFFERENT agent alone" — pins that the release is
 *      scoped to the agent it names.
 *
 * Cases 1 and 4 assert the EFFECT on the lock rather than that a release was
 * recorded. The four pre-existing release assertions (updateAgent, canary,
 * loadout, version-history) all check `versionLock.releases` length only, and a
 * `releaseAll` that records the call and frees nothing leaves every one of them
 * green — reported as a finding, not fixed here.
 *
 * BLOCKER-CLOSURE DELTA (2026-09-04) — agents 517 -> 515 (-4 +2). On the
 * branch that read 1517 -> 1515; integrated it is 3849 -> 3847.
 * The file count is UNCHANGED at 25. This row goes DOWN, which is the movement
 * this census exists to make a reviewer look at, so the arithmetic is written
 * out rather than summarised: 517 - 3 - 1 + 2 = 515.
 *
 *   -3  `domain/agent.test.ts`, the whole "slug uniqueness is scoped to the
 *       project" block, deleted WITH the function it tested.
 *       `domain/agent.ts::slugIsTaken` was a second implementation of a rule the
 *       use case already applies, and an unwireable one: it reads `Agent[]`
 *       filtered by project, and the only caller — `create-agent.ts` — holds
 *       `readonly string[]` from `listProjectSlugs(projectId)`, a read the
 *       repository port deliberately shapes that way. Its `excluding` parameter
 *       had no possible caller either: nothing in this context renames a slug.
 *       The rule keeps exactly one home, in the use case, over the data it has.
 *   -1  `application/authorization.test.ts`, "reads the project off the grant's
 *       own re-derived scope", deleted WITH `authorization.ts::projectOf` — a
 *       one-line duplicate of `grant.scope.projectId`, which `create-agent.ts`
 *       reads directly. Nothing else in the tree called it.
 *   +2  the two "REFUSES when even the disambiguated slug is taken" cases, one
 *       in `application/clusters.test.ts` and one in
 *       `application/agent-write.test.ts`. `resolveSlug` disambiguates ONCE by
 *       design, and both use cases carry a guard for the second collision so an
 *       operator gets a sentence rather than a unique-index violation. Neither
 *       guard had a case, and the trap is that the obvious one is VACUOUS: the
 *       in-memory stores simulate the index and raise the SAME error code, so a
 *       case asserting only the code passes with the guard deleted. Both assert
 *       the WRITE LOG is empty, which is the only thing that separates
 *       "refused before the write" from "refused by the store".
 *
 * `domain/cluster.ts::clusterSlugIsTaken` was the third of these unwired guards
 * and is the one that was WIRED rather than deleted: `clusters.ts` holds the
 * full `AgentCluster[]`, so the predicate fits its call site exactly, and it
 * restores the environment comparison the inline `taken.includes(slug)` had
 * dropped. Its own cases are unchanged, which is why they are not in the
 * arithmetic above.
 *
 * No other package moved.
 * Any further drift is a finding to report, not a number to force.
 *
 * ---------------------------------------------------------------------------
 * `tools` ARRIVES NEXT, AND ITS THREE WAVES ARE CARRIED VERBATIM BELOW WITH ONE
 * CORRECTION: every running TOTAL it quotes was read off its own branch, where
 * the only real context was `tools` itself and the base was the 1000 that closed
 * MAJOR 2. In THIS tree the base is the 3847 above, so 1000 -> 1299 -> 1325 ->
 * 1362 there is 3847 -> 4146 -> 4172 -> 4209 here. The per-row deltas — 299, 26
 * and 37 — are properties of the suites and are unchanged, which is why they are
 * the numbers to check. The file count it quotes as "106" is the same kind of
 * branch-local reading: this tree has 242 files before `tools` and 261 after.
 * ---------------------------------------------------------------------------
 *
 * WIN-256, `tools` (ADR M0.3 §1 context 7). One row moves:
 *
 *   tools 0 -> 18 files, 0 -> 299 cases; 3847 -> 4146 total. 13 domain suites,
 *   4 application suites and the contracts-barrel suite. The census REFUSED
 *   nothing in that tree, so its 299 is a statically exact count, and
 *   `pnpm --filter @platos/context-tools exec vitest run` prints the same pair
 *   — "Test Files 18 passed (18) / Tests 299 passed (299)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * Verified as a LIVE control, the same way the providers row was: deleting one
 * `it()` from `tools/domain/permission.test.ts` leaves the file count at 260
 * and turns the case count red, which is precisely the drift a file-count pin
 * cannot see. No other package moved.
 *
 * WIN-256, `tools` again — the hosted-MCP gate. The SAME row moves again, and
 * the file count does not:
 *
 *   tools 299 -> 325 cases; 4146 -> 4172 total. 18 files, unchanged: every one
 *   of the 26 added cases lands in a suite that already existed. That shape is
 *   the point of this canary — a wave that adds only assertions is invisible to
 *   a file-count pin, and 26 of them is exactly the size of change that would
 *   otherwise pass unremarked.
 *
 *   Where the 26 went, and why each is a case rather than a comment:
 *
 *     +14  application/tool-policy.test.ts (10 -> 24). The hosted MCP surface
 *          had NO authentication before this wave: `verifyMcpCaller` and
 *          `MCP_TOOLS_PERMISSION` were deletable with the whole suite green.
 *          Eleven of the fourteen are refusals — absent, unknown, wrong-scope
 *          and permission-less credentials; a surface switched off; a caller
 *          missing a scope label, an explicit un-exposure, a token allowlist it
 *          is not on, and a bearer caller on an oidc surface — and three are
 *          the positive controls without which a refusal test passes for the
 *          wrong reason (parent-project containment, the caller's own token id,
 *          and labels taken from the verified principal).
 *     +4   application/mcp-surface.test.ts (14 -> 18). Two for the
 *          `secret:mutate` gate on the switch that makes an entity's tools
 *          publicly reachable, which was deletable; two for the audit window,
 *          whose only case asked a window of an EMPTY store.
 *     +4   contracts/index.test.ts (10 -> 14). The same gate through the
 *          PUBLISHED contract, because a transport binds that object and a
 *          binder that dropped the credential would leave every use-case
 *          refusal above passing and production open.
 *     +2   application/execution.test.ts (31 -> 33). The not-dispatchable
 *          refusal in `resolveDispatchTarget`, with its positive control.
 *     +2   application/tool-policy.test.ts, allowlist resync — counted in the
 *          +14 above; named here because they are the two that need the
 *          repository double's new by-name failure injection.
 *
 *   `pnpm --filter @platos/context-tools exec vitest run` prints the same pair
 *   — "Test Files 18 passed (18) / Tests 325 passed (325)" — which is the
 *   agreement EXPECTED_RUNTIME_TOTAL exists to enforce. No other package moved,
 *   and no case was deleted: 299 + 26 = 325 and 4146 + 26 = 4172.
 *
 * WIN-256, `tools` a third time — the unproven-guard wave. Both numbers on the
 * row move, and the file is the point:
 *
 *   tools 18 -> 19 files, 325 -> 362 cases; 4172 -> 4209 total.
 *
 *   +29  contracts/operator-gate.test.ts, NEW (0 -> 29). The operator gate, on
 *        every published method that has one. `verifyOperator` guarded fourteen
 *        use cases and ELEVEN of them could have their guard deleted with all
 *        325 green — six of the eleven MUTATE. One case classifies every method
 *        on `Object.keys(contract)` as operator- or credential-authorized, so a
 *        method added to the surface later cannot arrive unclassified; fourteen
 *        refuse a grant tenancy did not mint; fourteen are the positive
 *        controls, without which a method that refused everything would satisfy
 *        its refusal case for the wrong reason. 1 + 14 + 14 = 29.
 *
 *        THE TWENTY-EIGHT ARE WRITTEN OUT RATHER THAN LOOPED, and this census
 *        is why. A `for` over the invocation table declares the same cases in
 *        four lines, and `declarationSiteIsCountable` REFUSES that shape —
 *        correctly, because a census that cannot count a suite exactly cannot
 *        canary it. The table is still the single source of the calls; only the
 *        `it()` declarations are unrolled.
 *
 *   +6   application/registry.test.ts (22 -> 28). The page clamp. Its one case
 *        asked `limit: 10_000, offset: -3` of a TWO-row fixture and asserted
 *        `items.length <= 200`, which holds with the clamp applied and with it
 *        removed. That case is now two — the window the port was actually
 *        handed, and the below-one/fractional window — and five more address
 *        the extracted `clampExposurePage` directly. 1 + 5 = 6.
 *
 *   +2   application/execution.test.ts (33 -> 35). The cost column on the row
 *        execution itself mints, and the per-entity `ToolHealth` key.
 *
 *   contracts/index.test.ts stays at 14: the gate suite that briefly lived
 *   there moved out whole, and the two cases it did change — the audit-row
 *   redaction case and the cost case — were REWRITTEN, not added to.
 *
 *   `pnpm --filter @platos/context-tools exec vitest run` prints "Test Files 19
 *   passed (19) / Tests 362 passed (362)", and the census REFUSES nothing in
 *   that tree, so 362 is a statically exact count. No other package moved and
 *   no case was deleted: 29 + 6 + 2 = 37, 325 + 37 = 362, 18 + 1 = 19, and
 *   4172 + 37 = 4209. *
 * ---------------------------------------------------------------------------
 * `channels` ARRIVES NEXT, AND ITS TWO WAVES ARE CARRIED BELOW WITH THE SAME
 * CORRECTION `tools` needed: every running TOTAL its branch quotes was read off
 * a tree whose only real context was `channels` and whose base was the 1000 that
 * closed MAJOR 2. Here the base is 4209, so 1000 -> 1263 -> 1269 there is
 * 4209 -> 4472 -> 4478 here. The per-row deltas — 263 and 6 — are properties of
 * the suites and are unchanged, which is why they are the numbers to check. Its
 * `credentialRevision` third axis on `ChannelInstallation` is carried
 * deliberately: `channel-persistence.service.ts` already enforces three axes, so
 * dropping it would be a silent regression rather than a simplification.
 * ---------------------------------------------------------------------------
 *
 * CHANNELS DELTA (2026-09-03), `tejas/win-256-channels-context` @ 4f6532a7
 * rebased onto v1 @ 95cbacc1. Another 0/0 placeholder becomes real, and again
 * exactly ONE row moves:
 *
 *   channels 0 -> 15 files, 0 -> 263 cases; 4209 -> 4472 total. 7 domain
 *   suites, 7 application suites and the contracts-barrel suite. The census
 *   REFUSED nothing in that tree, so its 263 is a statically exact count, and
 *   `pnpm --filter @platos/context-channels exec vitest run` prints the same
 *   pair — "Test Files 15 passed (15) / Tests 263 passed (263)".
 *
 * The source branch's own tip pinned channels at 14 files / 258 cases. The
 * difference is the five cases this rebase adds, all of them refusals with a
 * mutation control, and none of them a renumbering of anything that existed:
 *
 *   +2 cases in the NEW file `domain/connection.test.ts` (14 -> 15 files) —
 *   `assertEnabled`, the operator kill switch, had zero callers AND zero cases,
 *   so the module owning it shipped with no suite at all.
 *   +3 cases in `contracts/channels-contract.test.ts` — the disabled-connection
 *   refusal at the call site, its enabled control, and the revoked-installation
 *   refusal, which is the same gate on the app half of the inbound path.
 *
 * Every other package is unchanged. Any further drift is a finding to report,
 * not a number to force.
 *
 * CHANNELS, SECOND WAVE — the unenforced-fence wave. The SAME row moves again
 * and the FILE COUNT DOES NOT:
 *
 *   channels 263 -> 269 cases, 15 files; 4472 -> 4478 total. All six added
 *   cases land in suites that already existed, which is the shape this canary
 *   exists for — a wave that adds only refusals is invisible to a file-count
 *   pin.
 *
 *   +4  domain/installation.test.ts (30 -> 34). The refresh fence's THIRD AXIS.
 *       `RefreshExpectation.credentialRevision` was declared and never read —
 *       `ChannelInstallation` carried no revision to compare it against — so
 *       deleting the field entirely COMPILED and left all 263 of this context's cases green. Two cases
 *       on `beginRefresh` (a credential replaced in place with the generation
 *       unmoved is refused, and the positive control that differs from it by
 *       the revision ALONE), one on `finalizeRefresh` (the same fence at the
 *       moment of writing, which is a different window), and one on
 *       `releaseRefresh` (the one path that leaves the generation unchanged, so
 *       the one path where the generation axis alone cannot tell a stale claim
 *       from a live one).
 *   +1  contracts/channels-contract.test.ts (18 -> 19). `describeApp` is
 *       invisible across environments. Removing that one line from the
 *       repository double's `findApp` left this context's 263 green while removing the
 *       IDENTICAL line from `findConnection` turned two red.
 *   +1  application/channels-erasure-target.test.ts (12 -> 13). The
 *       substitution case became a REFUSAL case — `erasurePlanForeign` had zero
 *       producers while the error enumeration published its code — and the
 *       addition is the positive control that stops a target which threw at
 *       every plan from satisfying it.
 *
 *   `pnpm --filter @platos/context-channels exec vitest run` prints "Test Files
 *   15 passed (15) / Tests 269 passed (269)", and the census REFUSES nothing in
 *   that tree, so 269 is a statically exact count. No case was deleted and no
 *   other package moved: 4 + 1 + 1 = 6, 263 + 6 = 269, and 4472 + 6 = 4478.
 *
 * ---------------------------------------------------------------------------
 * `governance` ARRIVES NEXT, AND ITS WAVE IS CARRIED VERBATIM BELOW WITH ONE
 * CORRECTION, THE SAME ONE THE `tools` BLOCK ABOVE NEEDED. Every running TOTAL
 * it quotes was read off `tejas/win-256-governance-context`, which branched
 * from the agents branch and could therefore see only nine real contexts; its
 * base was 1515 and its tip 2124. In THIS tree the base is the 4478 above, so
 * 1515 -> 2124 there is 4478 -> 5087 here. The per-row delta — 31 files and 609
 * cases — is a property of the suites and is unchanged, which is why it is the
 * number to check. Nothing else in the block is branch-relative.
 * ---------------------------------------------------------------------------
 * WIN-256 DELTA — `governance` (ADR M0.3 §1 context 14) becomes real. One row
 * moves, and only one:
 *
 *   governance 0 -> 31 files, 0 -> 609 cases; 4478 -> 5087 total.
 *
 * The arithmetic is written out so a deletion cannot hide inside an addition:
 * 4478 + 609 = 5087, and the 609 is 0 + 586 + 1 + 22 rather than a net of
 * several movements. The file count did NOT move after the first pin, which is
 * exactly the drift a file-count pin is blind to. Both additions came from
 * review and both are worth naming.
 *
 * +1, THE FIXTURE THAT CERTIFIED A LIVE BUG. `application/criteria.ts` claimed
 * that deleting a criterion preserves the evals taken against it. The canonical
 * schema contradicts it — `AgentEval.criterion` is `onDelete: Cascade` — and the
 * claim had a passing test, which passed only because the in-memory criteria
 * store did not model the cascade. The store now cascades, the false case was
 * replaced by one reaching the null-name bucket through a criteria-read failure
 * (the claim that does hold), and a SECOND case asserts the evals really go.
 *
 * +22, GUARDS AND FILTERS NOTHING COULD TURN RED. An adversarial pass over the
 * suites found eleven places where a mutation to production code left every case
 * green, and each closure is a case here:
 *
 *   +5  the three criterion text ceilings (name, judge prompt, rubric) and the
 *       golden-set name ceiling had no case at all, so four `policy.max*Length`
 *       reads could be deleted silently. The rubric's ceiling ALSO answered the
 *       judge prompt's error code, which is two guards a test cannot tell apart;
 *       it now has `GOVERNANCE_CRITERION_RUBRIC_INVALID` of its own.
 *   +2  `applyCriterionPatch` could return a constant `isActive: false` — every
 *       existing assertion expected false — and every edited criterion would
 *       silently stop being scoreable at `runJudge` gate 4.
 *   +4  the two `agents` page ceilings were unreachable because no fixture ever
 *       seeded more rows than the ceiling; the version and agent doubles now
 *       APPLY their window and each ceiling has a reached case and a control.
 *   +2  `pageCriteria`'s `activeOnly` filter and `pageSafetyEvents`' search term
 *       could both be replaced by a constant.
 *   +2  the rating path's "refuses the operator WITHOUT reading the turn" was
 *       asserted by an empty store, which a refusal AFTER the read satisfies
 *       equally; `InMemoryRatingTargets` now keeps a read log.
 *   +2  `rawResponseTruncated` never reached the stored row, so the truncation
 *       "says so" to nobody. It is a column now, like `detailTruncated`.
 *   +3  a distinct dispatcher failure (`GOVERNANCE_QUEUE_UNAVAILABLE` was a code
 *       nothing produced), a distinct store failure beside it, and the judge
 *       body ceiling asserted with literals rather than with the constant it
 *       tests.
 *   +2  `readJudgeVerdict`'s under-ceiling case, and the golden-set store's own
 *       uniqueness constraint reached directly.
 * The 31 files are 16 domain suites, 14 application suites and the
 * contracts-barrel suite. The census REFUSED nothing in that tree, so its 609 is
 * a statically exact count, and
 * `pnpm --filter @platos/context-governance exec vitest run` prints the same
 * pair — "Test Files 31 passed (31) / Tests 609 passed (609)" — which is the
 * agreement EXPECTED_RUNTIME_TOTAL exists to enforce.
 *
 * Every one of the 14 application suites exists because a use case had no
 * control of its own, and the four written last are the ones that matter:
 * `governance-erasure-target.test.ts`, which reaches the target ONLY through the
 * published binder so a binder that drops `erasureTarget()` goes red rather than
 * leaving a factory-level suite green; `governance-contract.test.ts`, which
 * drives all 26 contract methods and pins both kernel ports by identity;
 * `regression-report.test.ts`, which holds the property the extraction source
 * cannot express — a run in which every judge call failed must not read as a
 * clean pass; and `risk-report.test.ts`, which holds the two flags that separate
 * an invented denominator from a measured one.
 *
 * No other package moved: this slice touched no suite outside governance and no
 * shared script but this one and `workspace-reachability.test.mjs`.
 *
 * ---------------------------------------------------------------------------
 * THE `conversations` PREREQUISITE ARRIVES NEXT, AND IT IS THE ONE WAVE-B SLICE
 * THAT ADOPTS NO CONTEXT. It moves an ALREADY-REAL row rather than turning a
 * zero row real, so it is the only delta in this file that does not change the
 * generator-ownership count in `scripts/workspace-reachability.test.mjs`, which
 * stays at 125. Its running totals below are corrected from its own branch's
 * base (v1, 1000) to this tree's (5087) exactly as the `tools` and `governance`
 * blocks above were.
 * ---------------------------------------------------------------------------
 * WIN-256 CONVERSATIONS PREREQUISITE (2026-09-04), on v1 `95cbacc13de6`. The
 * `ModelRouter` port grows the inference surface `conversations` needs (ADR
 * M0.3 §14), and again exactly ONE row moves:
 *
 *   providers 21 -> 25 files, 283 -> 346 cases; 5087 -> 5150 total. Four new
 *   suites, and every case in them is new -- nothing was renamed, moved between
 *   files, or deleted, so the +63 is an addition with no subtraction hiding in
 *   it:
 *
 *     domain/prompt.test.ts             13 cases  the message model
 *     domain/prompt-cache.test.ts       19 cases  breakpoint placement
 *     domain/generation.test.ts         14 cases  budgets, tools, usage sums
 *     application/run-model-generation.test.ts
 *                                       17 cases  the use case, end to end
 *                                       --------
 *                                       63
 *
 *   `domain/errors.test.ts` gains no case: its SAMPLES list grew by the ten new
 *   error codes, which is what its existing "mints every declared code and
 *   nothing else" case asserts over. That is the shape to check for when this
 *   number moves -- a suite whose case count is unchanged while its coverage
 *   changed is exactly what a file-count pin cannot see.
 *
 *   `pnpm --filter @platos/context-providers exec vitest run` prints the same
 *   pair: "Test Files 25 passed (25) / Tests 346 passed (346)".
 *
 * No other package moved. 21 + 4 = 25 files, 307 + 4 = 311 across the workspace;
 * 283 + 63 = 346 cases, 5087 + 63 = 5150 across the workspace. Its branch read
 * those workspace totals off v1, where providers was the only real context
 * besides the four that closed MAJOR 2: 88 files and 1000 cases there, 307 and
 * 5087 here. The per-row delta — 4 files and 63 cases — is the property that
 * conserves, and it is unchanged.
 *
 * WIN-256 MODEL ROUTER ADAPTER (2026-09-04), on the prerequisite branch
 * `7f266e3b`. The `ModelRouter` port gets its one implementation, and TWO rows
 * move -- the adapter, which had never held a case, and `providers`, which gains
 * the two pure pieces the adapter would otherwise have hidden beside an SDK call.
 *
 *   packages/adapters/model-router-providers   0 -> 15 files,   0 -> 198 cases
 *   packages/contexts/providers               25 -> 27 files, 346 -> 375 cases
 *
 * The adapter's 198, suite by suite. Fifteen files and not twelve: the
 * end-to-end suite was ONE file at 645 effective lines until the widened
 * max-file-lines selector could see it, and it is now four split by concern.
 *
 *     src/adapter.test.ts          20  the factory, open, probe, listModels
 *     src/call.test.ts             12  the joined abort, sampling, prepareStep
 *     src/clients.test.ts          13  dialect -> client, the service account
 *     src/failure.test.ts          13  abort vs auth refusal vs outage
 *     src/generation.test.ts        9  one step, the markers, the failures
 *     src/json-value.test.ts       11  making a tool result embeddable
 *     src/messages.test.ts         20  the prompt on the wire, and back
 *     src/object-output.test.ts     8  schema-shaped passes and their cost
 *     src/steps.test.ts             7  one step, and a call with no answer
 *     src/stream.test.ts            4  the one terminal event
 *     src/structured.test.ts       14  schema compile, validate, pass loop
 *     src/tool-loop.test.ts         5  round trips, budgets, input repair
 *     src/tools.test.ts            11  the tool bridge and the repair hook
 *     src/transport.test.ts        27  the retry policy, guard by guard
 *     src/usage.test.ts            24  the provider metadata chains
 *                                 ---
 *                                 198
 *
 * The +29 in `providers`, which is TWO new suites and one case added to each of
 * four existing ones:
 *
 *     domain/tool-input-repair.test.ts     16  new file
 *     domain/structured-output.test.ts      9  new file
 *     domain/errors.test.ts             9 -> 11  the adapter's seven codes are
 *                                              kept apart from the codes they
 *                                              resemble, and a failed schema
 *                                              loop carries what it spent
 *     domain/generation.test.ts        14 -> 15  the pass budget, under its own
 *                                              code and not the step budget's
 *     application/run-model-generation.test.ts
 *                                      17 -> 18  the pass budget refused before
 *                                              a route is opened
 *                                     ---
 *                                      29
 *
 *   `domain/errors.test.ts` also grows its SAMPLES list by the seven new codes
 *   without gaining a case for them, which its existing "mints every declared
 *   code and nothing else" case asserts over. That is the shape to check for
 *   when this number moves: a suite whose case count is unchanged while its
 *   coverage changed is exactly what a file-count pin cannot see.
 *
 * ARITHMETIC. Files: 311 + 15 + 2 = 328. Cases: 198 + 29 = 227 added, and
 * 5150 + 227 = 5377 across the workspace. Both entry points print the same
 * pairs: `pnpm --filter @platos/adapter-model-router-providers exec vitest run`
 * gives "Test Files 15 passed (15) / Tests 198 passed (198)", and
 * `pnpm --filter @platos/context-providers exec vitest run` gives
 * "Test Files 27 passed (27) / Tests 375 passed (375)".
 *
 * Its branch read the workspace totals off the prerequisite branch, where
 * providers and the four MAJOR-2 contexts were the only real rows: 92 files and
 * 1063 cases there, 311 and 5150 here. It therefore wrote 109 files and 1290
 * cases; NEITHER is the number on this tree. The per-row deltas — 15 files and
 * 198 cases in the adapter, 2 files and 29 cases in providers — are what
 * conserves, and they are unchanged.
 *
 * THIS IS ALSO THE FIRST TIME A ROW UNDER `packages/adapters` IS NONZERO, so the
 * census stops being a contexts-plus-kernel sum. The identity the v1-ledger
 * checks against this file moves with it, and is restated there rather than
 * quietly re-spelled.
 *
 * No other package moved. Any further drift is a finding to report, not a
 * number to force.
 *
 * WIN-257 OPERATOR IDENTITY DELTA (M2.2), `tejas/win-257-operator-identity` on
 * v1 `95cbacc1`, tranches 1 through 5. Two packages move:
 *
 *   identity-access 17 -> 23 files, 231 -> 318 cases. Six new suites:
 *   `application/identity-access-service.test.ts` and the two files its cookie
 *   cases later split into, `application/identity-access-service.end-users.test.ts`
 *   and `application/identity-access-service.session-cookie.test.ts` — that split
 *   was forced by the ADR M0.3 section 6 line budget, not by new coverage —
 *   plus `application/list-end-users.test.ts`, `domain/end-user.test.ts` and
 *   `domain/session-cookie.test.ts`.
 *
 *   tenancy 16 -> 20 files, 146 -> 207 cases. Four new suites:
 *   `application/create-organization.test.ts`, `application/create-project.test.ts`,
 *   `application/operator-read-models.test.ts` and `domain/visibility.test.ts`.
 *   `application/tenancy-service.test.ts` was EDITED and gains cases.
 *
 *   Workspace total 5377 -> 5525: +10 files and +148 cases. Its own branch read
 *   the totals off v1, where identity-access, tenancy, providers, secrets, files
 *   and the kernel were the only real rows: 88 files and 1000 cases there, 328
 *   and 5377 here. It therefore wrote 98 files and 1148 cases; NEITHER is the
 *   number on this tree. The per-row deltas — 6 files and 87 cases in
 *   identity-access, 4 files and 61 cases in tenancy — are what conserves, and
 *   they are unchanged.
 *
 *   `apps/core-api` gained composition cases and is outside PACKAGE_ROOTS, so it
 *   does not appear here. No other package moved. Any further drift is a finding
 *   to report, not a number to force.
 * ---------------------------------------------------------------------------
 * WIN-256 CONVERSATIONS (2026-09-04) — THE SEVENTEENTH AND LAST CONTEXT. The
 * turn-execution engine becomes real and exactly ONE row moves:
 *
 *   conversations 0 -> 29 files, 0 -> 350 cases; 5150 -> 5500 total.
 *
 * Every case is NEW. Nothing was renamed, moved between files, or deleted
 * anywhere in the workspace by this slice, so the +350 is an addition with no
 * subtraction hiding inside it — and the enumeration below is what makes that
 * checkable rather than asserted, because the twenty-nine parts must sum to the
 * whole:
 *
 *   domain/                                     application/
 *     attachment              12                  authorization           13
 *     errors                  13                  compact-thread          9
 *     postman-execution       9                   conversations-erasure-
 *     step                    9                     target                16
 *     step-rates              10                  execute-postman         12
 *     step-usage              12                  fork-thread             8
 *     structured-output       13                  manage-threads          18
 *     sub-agent               13                  run-sub-agent           12
 *     thread                  14                  run-turn                16
 *     thread-compaction       11                  turn-admission          11
 *     thread-fork             8                   turn-steps              15
 *     tool-catalogue          13                  turn-tools              13
 *     tool-result             12                                        ----
 *     transcript              11                                         143
 *     turn                    16                contracts/
 *     turn-cost               9                   index                   13
 *     work-status             9                                         ----
 *                           ----                                          13
 *                            194
 *
 *   194 + 143 + 13 = 350, across 17 + 11 + 1 = 29 files.
 *
 * `pnpm --filter @platos/context-conversations exec vitest run` prints the same
 * pair: "Test Files 29 passed (29) / Tests 350 passed (350)".
 *
 * No other package moved: this slice touched no suite outside conversations.
 * 311 + 29 = 340 files and 5150 + 350 = 5500 cases across the workspace.
 *
 * THE ONE NUMBER TO WATCH WHEN THIS MOVES. `run-turn.test.ts` holds 16 cases,
 * one of which is the failure-injection case that forces the write inside the
 * settlement transaction to refuse and asserts that NEITHER the settlement nor
 * its outbox event survived. Its case count would not move if that assertion
 * were weakened back to counting rollbacks, which is exactly the change a
 * file-count pin cannot see; `mutations.json` is where that guard is held
 * falsifiable, not here.
 *
 * M2 INTEGRATION MERGE. The two blocks above are each written against the same
 * 5150-case base and neither endpoint is the number on this tree: the adapter
 * plus WIN-257 wrote 5525, conversations wrote 5500, and the three deltas are
 * disjoint and SUM -- 5150 + 227 + 148 + 350 = 5875 across 311 + 17 + 10 + 29 =
 * 367 files. The per-row deltas are what conserves and every one is unchanged.
 *
 * THE LEDGER IDENTITY CHANGES SHAPE HERE, and it is written out rather than
 * quietly re-spelled: with `packages/adapters` nonzero the census is no longer a
 * contexts-plus-kernel sum, so it now closes as
 * packages.contexts.test 349 + packages.kernel.test 3 + packages.adapters.test 15
 * = 367. The pre-adapter form (contexts + kernel alone) would read 352 and is no
 * longer the identity; `v1-ledger.test.mjs` carries the same restatement.
 *
 * WIN-258 POSTGRES-TENANCY (M2.3). One package moves, the second nonzero row
 * under `packages/adapters`:
 *
 *   packages/adapters/postgres-tenancy   0 -> 4 files,   0 -> 56 cases
 *
 * 367 + 4 = 371 files and 5875 + 56 = 5931 cases. The adapters term of the
 * identity moves with it: 349 + 3 + 19 = 371.
 *
 * WHAT THE 56 ARE, because two of the four files are unlike anything else this
 * census counts:
 *
 *   client.test.ts                     17  the datasource URL and the driver
 *                                          error classification, both pure
 *   mapping.test.ts                    14  row -> record, and the three refusals
 *                                          for a column this binary cannot read
 *   repository.integration.test.ts     16  REAL PostgreSQL
 *   transaction.integration.test.ts     9  REAL PostgreSQL
 *
 * THE 25 INTEGRATION CASES DO NOT RUN IN `pnpm test:v1-packages`. They start a
 * container, and the typecheck job has no Docker daemon, so the package's own
 * `test` script excludes them by filename and the `postgres-tenancy-repository`
 * CI job runs them. They are counted here anyway, and deliberately: this census
 * measures the suites a package SHIPS, not the suites one runner happens to
 * execute, and a case that vanished from the tree would otherwise be invisible
 * to the pin. `differential-coverage` and the CI job are what make sure they run.
 *
 * THE NUMBER TO WATCH WHEN THIS MOVES. `transaction.integration.test.ts` holds
 * the failure-injection case that makes the SECOND write of a transaction fail
 * against a real database and then looks for the first row. Its case count would
 * not move if that assertion were weakened to counting rollbacks — the same
 * blind spot `run-turn.test.ts` has above — so `mutations.json` beside the
 * package is where that guard is held falsifiable, not here.
 *
 * WIN-258 TRANCHE 2 — THE IDENTITY-ACCESS CANONICAL STORE. The SAME package
 * moves again, because ADR M0.3 §15 puts both contexts' repositories in one
 * adapter directory:
 *
 *   packages/adapters/postgres-tenancy   4 -> 11 files,   56 -> 123 cases
 *
 * 371 + 7 = 378 files and 5931 + 67 = 5998 cases. The adapters term of the
 * identity moves with it: 349 + 3 + 26 = 378.
 *
 * WHAT THE 67 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   identity-mapping.test.ts                        17  scope assembly, the five
 *                                                       row refusals and the four
 *                                                       write guards, all pure
 *   identity-conformance.integration.test.ts         3  the fake and the adapter
 *                                                       asked the SAME questions,
 *                                                       plus two cases proving the
 *                                                       fake WRONG
 *   identity-constraints.integration.test.ts        16  rules that live only in
 *                                                       the migrations
 *   identity-transaction.integration.test.ts        11  failure injection, and the
 *                                                       three scope refusals
 *   identity-statements.integration.test.ts          7  measured statement counts
 *   identity-differential.integration.test.ts        4  against PlatosAuthService,
 *                                                       the session methods
 *   identity-differential-login.integration.test.ts  9  against PlatosAuthService,
 *                                                       the login paths, MFA,
 *                                                       impersonation and the one
 *                                                       divergence
 *
 * 17 + 3 + 16 + 11 + 7 + 4 + 9 = 67. The differential is TWO files because the
 * single file crossed the ADR M0.3 §6 hard limit of 500 effective lines and the
 * budget was pointing at a real seam. Six of the seven files are integration suites
 * and do not run in `pnpm test:v1-packages` for the reason stated above; the
 * `postgres-tenancy-repository` CI job runs them, and they are counted here
 * because this census measures the suites a package SHIPS.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 3 in the conformance suite. It is
 * small because it is ONE scenario of forty-six observations compared verbatim
 * against the in-memory fake, plus the two cases that assert the fake is wrong.
 * Adding an observation to that scenario strengthens it and moves no count here,
 * which is why `mutations-identity.json` is where those guards are falsifiable.
 *
 * WIN-258 TRANCHE 3 — TENANCY'S OTHER FIVE PORTS. The SAME package moves a
 * third time, for the third reason ADR M0.3 §15 gives: the row lock, the
 * advisory lock, the session revoker, the access-key revocation counter, the
 * invitation token issuer and the operator directory are the ports a use case
 * needs BESIDE the repository, and they are the same connection as the
 * repository.
 *
 *   packages/adapters/postgres-tenancy   11 -> 16 files,   123 -> 166 cases
 *
 * 378 + 5 = 383 files and 5998 + 43 = 6041 cases. The adapters term of the
 * identity moves with it: 349 + 3 + 31 = 383.
 *
 * WHAT THE 43 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   invitation-token.test.ts                    7  the only one of the five
 *                                                  ports provable with no
 *                                                  database: digest shape,
 *                                                  round trip, independence
 *   locks.integration.test.ts                  12  whether the locks BLOCK,
 *                                                  and the access-key fence
 *                                                  with its negative control
 *   ports-conformance.integration.test.ts       8  the fake and the adapter
 *                                                  asked the SAME questions,
 *                                                  plus six cases the shared
 *                                                  scenario cannot reach — one
 *                                                  of which is the only place
 *                                                  the two stores' advisory-lock
 *                                                  KEYS are compared
 *   ports-transaction.integration.test.ts      10  the three scope refusals on
 *                                                  all five methods, failure
 *                                                  injection, and the
 *                                                  OperatorSession rules
 *   ports-statements.integration.test.ts        6  measured statement counts
 *
 * 7 + 12 + 8 + 10 + 6 = 43. Four of the five are integration suites and do not
 * run in `pnpm test:v1-packages`, for the reason stated above; the
 * `postgres-tenancy-repository` CI job runs them.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 12 in `locks.integration.test.ts`.
 * Half of those cases assert an ORDERING across two concurrent transactions
 * rather than a returned value, because a lock that does not block returns
 * exactly what a lock that does returns. Weakening one of them to an assertion
 * on the boolean would move no count here, which is why `mutations-ports.json`
 * beside the package is where those guards are held falsifiable.
 *
 * WIN-258 TRANCHE 4 — THE KERNEL OUTBOX. TWO packages move, and they move for
 * two different reasons, so the delta is written as two rows rather than one:
 *
 *   packages/adapters/outbox              0 -> 4 files,    0 -> 41 cases
 *   packages/adapters/postgres-tenancy   11 -> 15 files, 123 -> 156 cases
 *
 * 378 + 4 + 4 = 386 files and 5998 + 41 + 33 = 6072 cases. The adapters term of
 * the identity moves by the same eight: 349 + 3 + 34 = 386.
 *
 * WHY THE OUTBOX IS TWO PACKAGES AT ALL. `Event` has an owner that is an ADAPTER
 * rather than a context, and ADR M0.3 §15 gives the ORM exactly one home — so
 * the package that owns the port cannot be the package that issues its INSERT.
 * `packages/adapters/outbox` keeps the identifier, the instant, the envelope and
 * every refusal; `packages/adapters/postgres-tenancy` holds the statement.
 *
 * WHAT THE 39 ARE, file by file:
 *
 *   event-id.test.ts        11  the UUIDv7 that makes `ORDER BY createdAt, id`
 *                               append order, and the five ways it could stop
 *   envelope.test.ts        15  the seven refusal codes, the object-root
 *                               constraint the double cannot see, and the
 *                               pre-envelope row a drain must still read
 *   adapter.test.ts         11  what `append` writes and what `drain` returns
 *   conformance.test.ts      4  the committed scenario against the double, plus
 *                               TWO negative controls: a store outside the
 *                               snapshot set and a store that never refuses
 *
 * 11 + 15 + 11 + 4 = 41. None of them needs a database, so all 41 run in
 * `pnpm test:v1-packages`.
 *
 * THE TWO ODD ONES OUT are the eleventh case in each of event-id and adapter,
 * and both were written because the MUTATION SWEEP found a survivor rather than
 * because a reviewer thought of them. `bytes[8] = tail[0]` — the variant bits
 * left as drawn — survived every case in the file, because the fixed tail those
 * cases use already carries the right two bits; and `createdAt: clock.now()` —
 * the raw reading rather than the clamped one — survived because every case
 * used a clock that stands still. A count that moved without that history is
 * exactly what this block exists to prevent.
 *
 * WHAT THE 33 ARE, and all 33 need a real PostgreSQL:
 *
 *   outbox-transaction.integration.test.ts   11  failure injection, the returned
 *                                                error value that COMMITS, and
 *                                                the five refusal codes
 *   outbox-constraints.integration.test.ts   12  rules and facts that live in
 *                                                the migrations or the catalogue
 *   outbox-statements.integration.test.ts     7  measured statement counts
 *   outbox-conformance.integration.test.ts    3  the committed scenario against a
 *                                                real database, and durability
 *                                                read on a SECOND connection
 *
 * 11 + 12 + 7 + 3 = 33. They are excluded from the package's default `test`
 * script by filename and run by the `postgres-tenancy-repository` CI job, and
 * counted here because this census measures the suites a package SHIPS.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 3 in the conformance suite and the 4
 * in the double's. Both are small because both are ONE scenario of twelve
 * observations compared verbatim against a committed transcript; adding an
 * observation strengthens the differential and moves no count here, which is why
 * `packages/adapters/outbox/mutations.json` is where those guards are held
 * falsifiable.
 *
 * TRANCHES 3 AND 4 LAND TOGETHER, AND THE PINS ARE THE SUM OF BOTH — never
 * either one. Each block above is correct against the same base and about a
 * DIFFERENT addition, so `packages/adapters/postgres-tenancy` moves twice:
 *
 *   packages/adapters/outbox              0 -> 4 files,     0 -> 41 cases
 *   packages/adapters/postgres-tenancy   11 -> 20 files,  123 -> 199 cases
 *
 * 11 + 5 (tranche 3) + 4 (tranche 4) = 20 files, and 123 + 43 + 33 = 199 cases.
 * The tree total is 378 + 5 + 4 + 4 = 391 files and 5998 + 43 + 41 + 33 = 6115
 * cases. The adapters term of the three-way identity carries both: 26 + 5 + 8 =
 * 39, and 349 + 3 + 39 = 391.
 *
 * THE FAILURE THIS PARAGRAPH EXISTS TO PREVENT is side-picking. Taking tranche
 * 3's 16/166 would have dropped the outbox's four suites and 33 cases; taking
 * tranche 4's 15/156 would have dropped the five ports' 43. Both readings pass
 * their own branch's arithmetic and neither is the tree.
 *
 * TRANCHE 5 — THE `tools` CANONICAL STORE — adds 6 files and 59 cases to
 * `packages/adapters/postgres-tenancy`, and to no other package at all. The
 * `tools` CONTEXT gains no test file: the port and its in-memory double already
 * existed and already had suites, and this tranche implements the port rather
 * than widening it.
 *
 * WHAT THE 59 ARE, and 39 of them need a real PostgreSQL:
 *
 *   tools-mapping.test.ts                    20  row -> domain mapping, the
 *                                                audit envelope's layout, and
 *                                                what a THROW becomes on the way
 *                                                out of the store; NO database,
 *                                                which is why it is the one
 *                                                countable unit suite of the six
 *   tools-constraints.integration.test.ts    12  rules that live ONLY in the
 *                                                migrations — the json-root
 *                                                CHECK, the four ancestry
 *                                                rules, the NULL-distinct
 *                                                unique index
 *   tools-isolation.integration.test.ts       8  which rows a statement may
 *                                                reach, and which columns a
 *                                                second write may not move
 *   tools-statements.integration.test.ts      7  measured statement counts, each
 *                                                pinned on a SMALL and a LARGE
 *                                                fixture so an N+1 moves one
 *   tools-conformance.integration.test.ts     5  the shared scenario against a
 *                                                real database, compared
 *                                                observation for observation
 *                                                with the in-memory double's
 *   tools-transaction.integration.test.ts     7  failure injection; a returned
 *                                                error `Result` that must COMMIT
 *                                                NOTHING; and the converse pair
 *                                                — a GUARD refusal the unit of
 *                                                work commits around, and a
 *                                                refusal POSTGRESQL raised,
 *                                                which takes the unit of work
 *                                                with it and still resolves
 *
 * 20 + 12 + 8 + 7 + 5 + 7 = 59. Five of the six are excluded from the package's
 * default `test` script by filename and run by the `postgres-tenancy-repository`
 * CI job.
 *
 * THE SIXTH FILE IS THE INTERESTING ONE, and it is not here because the tranche
 * grew. `tools-isolation.integration.test.ts` is eight cases that exist because
 * a MUTATION SURVIVED: the sweep in `mutations-tools.json` removed the ancestry
 * resolve's organization half, the replace's entity clause, the enable's tenant
 * clause and three orderings, and the five suites above stayed green for every
 * one. It is a separate file rather than an appendix to the constraints suite
 * because appending took that file to 467 effective lines, and the ADR M0.3 §6
 * budget was pointing at a real seam: migrations-only RULES on one side, what
 * the STORE decides on the other.
 *
 * THE NUMBER TO WATCH HERE is the 5 in the conformance suite. It is small for
 * the same reason the outbox's 3 is: it is ONE scenario compared verbatim, so
 * adding an observation strengthens the differential and moves no count in this
 * file. `packages/adapters/postgres-tenancy/mutations-tools.json` is where those
 * guards are held falsifiable instead.
 *
 *
 * WIN-258 TRANCHE 5 — THE `agents` CANONICAL STORE (M2.3) adds 6 files and 60
 * cases to `packages/adapters/postgres-tenancy`, and nothing anywhere else:
 *
 *   agents-guards.test.ts                     14  the refusal parser, against the
 *                                                 THREE shapes a refusal actually
 *                                                 arrives in, every fixture copied
 *                                                 off a container
 *   agents-rows.test.ts                        7  the two readers that REFUSE
 *                                                 rather than inventing a value,
 *                                                 neither of them reachable
 *                                                 through PostgreSQL today
 *   agents-conformance.integration.test.ts     2  the two halves of the shared
 *                                                 scenario, run against the
 *                                                 double and against PostgreSQL
 *                                                 and compared step by step
 *   agents-constraints.integration.test.ts    16  what the MIGRATIONS refuse and
 *                                                 `schema.prisma` does not say
 *   agents-transaction.integration.test.ts    12  failure injection, the three
 *                                                 transaction-scope refusals,
 *                                                 the savepoint measured from a
 *                                                 SECOND connection, and the
 *                                                 parent row lock
 *   agents-statements.integration.test.ts      9  measured statement counts
 *
 * 14 + 7 + 2 + 16 + 12 + 9 = 60, over 6 files, and every one of the six numbers
 * is READ BACK from the counter in this file rather than tallied by hand. Four
 * of the six are excluded from the package's default `test` script by filename
 * and run by the `postgres-tenancy-repository` CI job; `agents-guards.test.ts`
 * and `agents-rows.test.ts` are not, because neither module has a database in
 * it.
 *
 * THE TWO UNIT FILES ARE HERE BECAUSE A SWEEP PUT THEM HERE, and that is the
 * honest order of events. `agents-guards.test.ts` exists because two entries of
 * `mutations-agents.json` SURVIVED: the branches that read a refusal out of a
 * raw statement's `meta` are reached by no delegate call in this adapter, so
 * nothing could turn them red. The suite falsifies them against the exact error
 * objects, rather than the branches being deleted as dead code.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 2 in the conformance suite. It is two
 * because it is TWO scenarios compared verbatim -- 47 observations over
 * `AgentsRepository` and 29 over `ScaffoldingRepository`, both READ OFF a run.
 * Adding an observation strengthens the differential and moves no count here,
 * which is why `mutations-agents.json` is where those guards are held
 * falsifiable.
 *
 *
 * WIN-258 TRANCHE 5 - COST-MONITORING'S CANONICAL STORE. The SAME package moves
 * a SIXTH time, for the sixth reading of ADR M0.3 §15: `cost-monitoring` is
 * sole writer of six rows in the same PostgreSQL database, so its repositories
 * are the same client, the same transaction and the same directory.
 *
 * WHAT THE 61 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   cost-rows.test.ts                         22  the mapping in both
 *                                                 directions and every guard,
 *                                                 PURE — the only one of the six
 *                                                 that `pnpm test:v1-packages`
 *                                                 actually runs
 *   cost-constraints.integration.test.ts      13  each guard against the CHECK it
 *                                                 restates, in two halves, plus
 *                                                 the three guards that have no
 *                                                 constraint behind them
 *   cost-rules.integration.test.ts             8  the database rules NO port
 *                                                 method restates: immutability,
 *                                                 the ancestry rule firing on
 *                                                 UPDATE, the credential rule,
 *                                                 the tombstone this port cannot
 *                                                 write, and cross-scope denial
 *   cost-transaction.integration.test.ts       7  failure injection on both
 *                                                 two-statement operations, each
 *                                                 with a negative control, and
 *                                                 the three scope refusals
 *   cost-statements.integration.test.ts        6  measured statement counts over
 *                                                 two fixture sizes, the probe
 *                                                 anchor, and the three writes
 *                                                 whose count is the contract
 *   cost-conformance.integration.test.ts       5  the scenario against the fake
 *                                                 and the real store, compared
 *                                                 verbatim, plus non-vacuity
 *
 * 22 + 13 + 8 + 7 + 6 + 5 = 61. Five of the six need a real PostgreSQL and are
 * run by the `postgres-tenancy-repository` CI job, not by
 * `pnpm test:v1-packages`; they are counted here because this census measures
 * the suites a package SHIPS.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 5 in the conformance suite. It is
 * small because it is ONE scenario of forty-five observations compared verbatim
 * against `InMemoryBudgetRepository`; adding an observation strengthens the
 * differential and moves NO count here, which is why `mutations-cost.json`
 * beside the package is where those guards are held falsifiable.
 *
 * THE 6 IN THE STATEMENTS SUITE IS ALSO SMALL ON PURPOSE, and for a reason this
 * census enforced: it began as ten cases generated in a `for` loop over a table
 * of reads, which this script REFUSES to count. The loop became two cases over a
 * map of every read, which is the better instrument anyway — a divergence names
 * the read and shows both counts, and a read somebody forgot to measure cannot
 * exist.
 *
 * WIN-258 TRANCHE 5, SECOND SWEEP — THE SEVENTH SUITE. The same package moves a
 * FIFTH time, and the mutation ledger is what moved it:
 *
 *   packages/adapters/postgres-tenancy   26 -> 27 files,  260 -> 264 cases
 *
 * 397 + 1 = 398 files and 6176 + 4 = 6180 cases. The adapters term of the
 * three-way identity moves with it: 349 + 3 + 46 = 398.
 *
 * WHAT THE 4 ARE, and why they are not in any file above:
 *
 *   cost-idempotency.integration.test.ts   4  the insert form that does not
 *                                             raise, the uuid shape test the
 *                                             vault's revoke depends on, the
 *                                             terminal status that stops a
 *                                             second send, and the count test
 *                                             that keeps a stale dispatcher's
 *                                             send record out of the history
 *
 * THE REASON IT IS A SEVENTH FILE rather than four more cases in the conformance
 * suite is the one this census exists to make visible. Re-running all forty
 * ledger entries scored SIX with zero executed cases: the edits compiled and
 * collected, then broke `cost-conformance.integration.test.ts` while it was
 * BUILDING its transcript, in a `beforeAll`, so vitest reported every case in
 * the file SKIPPED and the file's pin of 5 did not move. Two of the six had a
 * named case elsewhere in the tree; the four above had none anywhere, and a
 * guard whose only witness is a crashed hook is a guard this census cannot see.
 * The conformance suite's own 5 is unchanged, which is the point: these four
 * observations could not have been added there without being invisible.
 *
 * WIN-258 TRANCHE 5, `governance`'s canonical store, adds SIX more suites to
 * that same row and not one case to any context:
 *
 *   packages/adapters/postgres-tenancy   39 -> 45 files,  383 -> 449 cases
 *
 * governance-conformance.integration.test.ts    1   the differential, one case
 *                                                  driving one scenario twice
 * governance-constraints.integration.test.ts   12   what the migrations refuse
 *                                                  and a double accepts, in PAIRS
 * governance-rows.test.ts                      21   the PURE mapping branches a
 *                                                  container suite cannot reach
 * governance-rules.integration.test.ts         10   the database rules no port
 *                                                  method restates
 * governance-statements.integration.test.ts    15   every read pinned twice,
 *                                                  small fixture and one 20x larger
 * governance-transaction.integration.test.ts    7   failure injection and the
 *                                                  three scope refusals
 *
 * THE CONFORMANCE SUITE IS ONE CASE, and that is the shape of this instrument
 * rather than a thin suite: it drives ONE scenario against the doubles and then
 * against the adapter and compares the two transcripts key by key, so what a
 * second case would add is a second scenario and not a second assertion. The
 * scenario itself records more than fifty observations, and the suite asserts
 * that it recorded more than forty — a run that recorded nothing would satisfy
 * every comparison in it.
 *
 * WIN-258 TRANCHE 5 AGAIN — `secrets`' canonical store, the FOURTH in the same
 * package. NINE files, 83 cases, and not one of them anywhere else:
 *
 *   secrets-rows.test.ts                        18  the three closed unions a
 *                                                   row is read back through,
 *                                                   the readers' copying, and
 *                                                   each of the nine guards on
 *                                                   BOTH sides of its boundary.
 *                                                   It runs under the default
 *                                                   `test` script; the six below
 *                                                   do not.
 *   secrets-rules.integration.test.ts           11  the database rules NO port
 *                                                   method restates: four
 *                                                   immutability rules, the five
 *                                                   clauses `enforce_win124_
 *                                                   credential_kind` re-reads,
 *                                                   the ON DELETE RESTRICT on an
 *                                                   ACTIVE envelope, and the one
 *                                                   place the double and the
 *                                                   database disagree about what
 *                                                   a row IS
 *   secrets-statements.integration.test.ts      10  every read measured twice,
 *                                                   over one row and over twelve
 *   secrets-conformance.integration.test.ts      8  the differential against
 *                                                   `inMemorySecretsStore`
 *   secrets-constraints.integration.test.ts      8  each vault guard beside the
 *                                                   migration CHECK it restates
 *   secrets-transaction.integration.test.ts      7  failure injection, the three
 *                                                   scope refusals, the ambient
 *                                                   read and the row lock
 *   secrets-variable-constraints.integration     7  the variable's three CHECKs
 *     .test.ts                                      and the two guards standing
 *                                                   where no CHECK does
 *   secrets-scope.integration.test.ts            6  the clauses that decide
 *                                                   WHICH ROW a call reaches:
 *                                                   the environment clause on
 *                                                   the row lock, the total
 *                                                   order under a non-unique
 *                                                   query, and the purge sweep's
 *                                                   retention window, cutoff and
 *                                                   `FOR UPDATE OF version`
 *   secrets-refusals.integration.test.ts         7  the seven refusals whose
 *                                                   ONLY witness was a crashed
 *                                                   hook: every one is a
 *                                                   `Result` where a naive
 *                                                   store would RAISE, and the
 *                                                   conformance suite drives
 *                                                   them all inside a
 *                                                   `beforeAll`
 *
 * TWO OF THE NINE EXIST BECAUSE OF THE SWEEP, exactly as `cost-idempotency`
 * did one store over. `secrets-scope` carries six clauses that had no named case
 * anywhere in the tree -- each was falsifiable only through a transcript that
 * happened to differ, or not at all. `secrets-refusals` carries seven that the
 * first sweep scored VACUOUS: each is a `Result` where a naive store would
 * RAISE, the conformance suite drives all seven inside the `beforeAll` that
 * builds its transcript, and a raise there made vitest report every case in the
 * file SKIPPED. A guard whose only witness is a crashed hook is a guard nothing
 * can see.
 *
 * EIGHT OF THE NINE ARE EXCLUDED from the package's default `test` script by
 * filename and run by the `postgres-tenancy-repository` CI job, exactly as the
 * other three tranche-5 stores' suites are.
 *
 * ALL FOUR TRANCHE-5 STORES LAND IN THE SAME PACKAGE, so the four blocks above
 * SUM rather than any one standing alone. No branch's arithmetic is right
 * merged, and side-picking one would under-count the others by their whole
 * tranche:
 *
 *   packages/adapters/postgres-tenancy   20 -> 45 files,  199 -> 449 cases
 *
 * 20 + 6 + 6 + 7 = 39 files and 199 + 59 + 60 + 65 = 383 cases. The tree total
 * is 391 + 19 = 410 files and 6115 + 184 = 6299 cases. The adapters term of the
 * three-way identity carries all nineteen, because every added file is an
 * adapter's: 39 + 19 = 58, and 349 + 3 + 58 = 410.
 *
 * WIN-258 TRANCHE 5 - CHANNELS' CANONICAL STORE. The SAME package moves a
 * SEVENTH time, for the seventh reading of ADR M0.3 §15: `channels` is sole
 * writer of six rows in the same PostgreSQL database, so its repository is the
 * same client, the same transaction and the same directory.
 *
 *   packages/adapters/postgres-tenancy   39 -> 45 files,  383 -> 455 cases
 *
 * WHAT THE 72 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   channels-rows.test.ts                     25  the mapping in both directions
 *                                                 and every guard, PURE - the
 *                                                 only one of the six that
 *                                                 `pnpm test:v1-packages` runs
 *   channels-constraints.integration.test.ts  16  each guard against the
 *                                                 migration-only CHECK it
 *                                                 restates, plus the six that
 *                                                 have no constraint behind them
 *                                                 and are shown going in clean
 *                                                 through SQL
 *   channels-rules.integration.test.ts        10  the database rules NO port
 *                                                 method restates: the immutable
 *                                                 inbox identity, the ancestry
 *                                                 rule firing on UPDATE, the
 *                                                 owner column that will not
 *                                                 move, the turn unique, and the
 *                                                 revision this table has no
 *                                                 column for
 *   channels-transaction.integration.test.ts  10  failure injection over a
 *                                                 second client, the negative
 *                                                 control, BOTH answers a
 *                                                 returned error Result gives,
 *                                                 and the three scope refusals
 *   channels-statements.integration.test.ts    6  measured statement counts over
 *                                                 two fixture sizes, the probe
 *                                                 anchor, and the three writes
 *                                                 whose count is the contract
 *   channels-conformance.integration.test.ts   5  the scenario against the fake
 *                                                 and the real store, compared
 *                                                 verbatim, plus non-vacuity
 *
 * 25 + 16 + 10 + 10 + 6 + 5 = 72. Five of the six need a real PostgreSQL and are
 * run by the `postgres-tenancy-repository` CI job, not by
 * `pnpm test:v1-packages`; they are counted here because this census measures
 * the suites a package SHIPS.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 5 in the conformance suite. It is
 * small because it is ONE scenario of thirty-five observations compared verbatim
 * against `InMemoryChannelsRepository`; adding an observation strengthens the
 * differential and moves NO count here, which is why `mutations-channels.json`
 * beside the package is where those guards are held falsifiable.
 *
 * ALL THREE OF THIS WAVE'S STORES LAND IN THIS ONE PACKAGE, so its row is the
 * SUM: 20 + 6 + 6 + 7 + 6 + 6 + 9 = 60 files and
 * 199 + 59 + 60 + 65 + 72 + 66 + 83 = 604 cases. `channels` contributes 6 files
 * / 72 cases, `governance` 6 / 66 and `secrets` 9 / 83, and no branch's own
 * figure — 45/455, 45/449 or 48/466 — survives the merge. The tree total is
 * 391 + 40 = 431 files and 6115 + 405 = 6520 cases. The adapters term of the
 * three-way identity carries all forty, because every added file is an
 * adapter's: 39 + 40 = 79, and 349 + 3 + 79 = 431.
 * WIN-258 TRANCHE 5 - PROVIDERS' CANONICAL STORE. The SAME package moves a
 * TENTH time, for the tenth reading of ADR M0.3 §15: `providers` is sole writer
 * of four rows in the same PostgreSQL database, so its repository is the same
 * client, the same transaction and the same directory.
 *
 *   packages/adapters/postgres-tenancy   60 -> 67 files,  604 -> 681 cases
 *
 * WHAT THE 77 ARE, file by file, so the total cannot absorb a loss elsewhere:
 *
 *   providers-rows.test.ts                     17  the crossing in both
 *                                                  directions, the three column
 *                                                  renames, every guard and the
 *                                                  two unreadable-row refusals,
 *                                                  PURE - the only one of the
 *                                                  seven `pnpm test:v1-packages`
 *                                                  runs
 *   providers-conformance.integration.test.ts  11  the scenario against the fake
 *                                                  and the real store compared
 *                                                  verbatim, plus non-vacuity,
 *                                                  the listing order, the two
 *                                                  unique refusals told apart,
 *                                                  the Decimal(24, 12) round
 *                                                  trip and the model identity
 *   providers-constraints.integration.test.ts  13  `ProviderKey`'s five database
 *                                                  rules, each guard beside the
 *                                                  rule it restates and each
 *                                                  rule shown refusing a raw
 *                                                  statement that steps around
 *                                                  the guard
 *   providers-catalogue-constraints
 *     .integration.test.ts                     12  the same pairing for `Model`
 *                                                  and `ModelPrice`: the rate
 *                                                  CHECK in both directions, the
 *                                                  append-only rules, the
 *                                                  SECOND identity the port does
 *                                                  not model, and the INTEGER
 *                                                  columns
 *   providers-rules.integration.test.ts        10  the rules NO port method
 *                                                  restates: the delete rule
 *                                                  in BOTH places a version can
 *                                                  pin a key, its own provider
 *                                                  negative control, the scoped
 *                                                  count, the collation
 *                                                  disagreement and the second
 *                                                  adoption
 *   providers-transaction.integration.test.ts   7  failure injection over a
 *                                                  second client, the negative
 *                                                  control, BOTH answers a
 *                                                  returned error Result gives,
 *                                                  the touch that survives a
 *                                                  rollback, and the three scope
 *                                                  refusals
 *   providers-statements.integration.test.ts    7  measured statement counts over
 *                                                  two fixture sizes, the probe
 *                                                  anchor, and the three writes
 *                                                  whose count is the contract
 *
 * 17 + 11 + 13 + 12 + 10 + 7 + 7 = 77. Six of the seven need a real PostgreSQL
 * and are run by the `postgres-tenancy-repository` CI job, not by
 * `pnpm test:v1-packages`; they are counted here because this census measures
 * the suites a package SHIPS.
 *
 * TWO OF THE SEVEN ARE THIS TRANCHE'S OWN SPLITS, and both were forced rather
 * than chosen. The constraints proof measured 491 effective lines as one file,
 * four lines of prose from the §6 hard error, and it split along the port's own
 * seam: `ProviderKey`'s rules are environment-scoped and every case needs a
 * tenant chain and a credential, while `Model` and `ModelPrice` have no scope at
 * all. The conformance SCENARIO is two modules for the same reason and is
 * counted once, under the suite that drives it.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 11 in the conformance suite. It is
 * small because it is ONE scenario of sixty-two observations compared verbatim
 * against `InMemoryProvidersRepository`; adding an observation strengthens the
 * differential and moves NO count here, which is why `mutations-providers.json`
 * beside the package is where those guards are held falsifiable.
 *
 *
 * WIN-258 TRANCHE 5, `conversations` — the NINTH owner of the one ORM home, and
 * the tranche whose suite COUNT was decided by `max-file-lines` rather than by
 * choice. Eight files, 97 cases:
 *
 *   conversations-rows.test.ts                  24  the turn rollup from its
 *                                                   STEPS — six of the nine
 *                                                   numbers have no column —
 *                                                   the exponential decimal the
 *                                                   driver renders below 1e-7,
 *                                                   the scale padding that makes
 *                                                   the round trip exact, every
 *                                                   stored enum validated rather
 *                                                   than cast, and the
 *                                                   half-written rate
 *   conversations-constraints.integration.test.ts
 *                                               14  each Thread and Turn guard
 *                                                   stood beside the migration
 *                                                   CHECK it restates, in two
 *                                                   halves: the store's refusal
 *                                                   and the database's
 *   conversations-billing-constraints.integration.test.ts
 *                                               12  the same instrument over
 *                                                   `Step_usage_check` and the
 *                                                   two PostmanExecution regular
 *                                                   expressions, split out when
 *                                                   the file passed the 500-line
 *                                                   hard error
 *   conversations-isolation.integration.test.ts 11  the three immutability
 *                                                   rules and the tenant
 *                                                   boundary — four rows unique
 *                                                   INSTALLATION-WIDE, one of
 *                                                   them a capability
 *   conversations-rules.integration.test.ts     11  the transcript filter the
 *                                                   double does not implement,
 *                                                   the organization-scoped
 *                                                   erasure it ignores, and the
 *                                                   deletion order two rules
 *                                                   force
 *   conversations-transaction.integration.test.ts
 *                                                8  failure injection over a
 *                                                   second client, the negative
 *                                                   control, the three scope
 *                                                   refusals, and the row lock
 *                                                   a second allocator BLOCKS on
 *   conversations-statements.integration.test.ts
 *                                               16  measured statement counts
 *                                                   over two fixture sizes, the
 *                                                   probe anchor, and the ONE
 *                                                   read whose count is zero
 *   conversations-conformance.integration.test.ts
 *                                                1  the scenario against the
 *                                                   fake and the real store,
 *                                                   compared verbatim
 *
 * 24 + 14 + 12 + 11 + 11 + 8 + 16 + 1 = 97. Seven of the eight need a real
 * PostgreSQL and are run by the `postgres-tenancy-repository` CI job.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 1 in the conformance suite, for the
 * reason `channels`' 5 is: it is ONE scenario compared verbatim against
 * `InMemoryConversations`, so adding an observation strengthens the differential
 * and moves NO count here. `mutations-conversations.json` beside the package is
 * where those guards are held falsifiable — 56 entries, 56 killed.
 *
 *
 *
 * WIN-258 TRANCHE 5 ONCE MORE — `skills`' canonical store, the FIFTH in the same
 * package. SIX files, 62 cases, and not one of them anywhere else:
 *
 *   skills-rows.test.ts                        19  the row readers and the eight
 *                                                  write guards, on BOTH sides of
 *                                                  each boundary, plus the
 *                                                  assertion that all thirteen
 *                                                  refusal codes are distinct, and
 *                                                  the default stamps measured over
 *                                                  a thousand readings. It runs
 *                                                  under the default `test` script;
 *                                                  the five below do not.
 *   skills-rules.integration.test.ts           15  rows an OLDER BINARY could have
 *                                                  written, planted as SQL — a
 *                                                  NULL `TEXT[]`, an origin
 *                                                  outside the closed set, a thin
 *                                                  manifest, a manifest carrying a
 *                                                  key this release has never
 *                                                  heard of — and the TWO
 *                                                  divergences between this store
 *                                                  and the double, pinned rather
 *                                                  than hidden, and the two write
 *                                                  paths whose input the port
 *                                                  itself cannot produce.
 *   skills-constraints.integration.test.ts     17  the six migration-only
 *                                                  constraints read back out of
 *                                                  `pg_catalog`, then falsified in
 *                                                  PAIRS: the double accepts, the
 *                                                  canonical schema refuses — plus
 *                                                  the FIVE clauses that decide
 *                                                  WHICH ROW a call reaches, two of
 *                                                  which exist because the first
 *                                                  mutation sweep left their guards
 *                                                  standing with nothing red.
 *   skills-transaction.integration.test.ts      7  failure injection over a SECOND
 *                                                  client, and the three scope
 *                                                  refusals under their three
 *                                                  distinct codes.
 *   skills-conformance.integration.test.ts      2  the differential, one case
 *                                                  driving one scenario twice, and
 *                                                  its negative control.
 *   skills-statements.integration.test.ts       2  every count measured over a
 *                                                  small fixture AND one 20x
 *                                                  larger, in ONE map, plus the
 *                                                  probe-filter case that keeps the
 *                                                  measurement from discarding what
 *                                                  it measures.
 *
 * 19 + 15 + 17 + 7 + 2 + 2 = 62. Five of the six need a real PostgreSQL and are
 * run by the `postgres-tenancy-repository` CI job.
 *
 * NINE OF THE SIXTY-TWO EXIST BECAUSE THE MUTATION LEDGER WAS ENUMERATED FIRST,
 * SEVEN BEFORE THE SWEEP AND TWO BECAUSE OF IT. Five guards had no case anywhere that could go red — the uuid guard on
 * the PATCH path, the project and organization halves of a binding read, the
 * `organizationId` clause of the raw anonymisation, the re-enable half of both
 * install upserts, and `jsonb_set(create_missing => true)` — and two more prove
 * the default stamps directly. `mutations-skills.json` names each of them.
 *
 * TWO OF ITS SUITES ARE ONE CASE APIECE AND THAT IS THE INSTRUMENT, not a thin
 * suite. The conformance differential drives ONE scenario against the double and
 * then against PostgreSQL and compares the two transcripts key by key — the
 * scenario records more than fifty observations and the suite asserts it
 * recorded more than forty, so a run that recorded nothing would satisfy every
 * comparison in it. The statement suite measures EVERY method over both
 * fixtures into one map and compares the map, so a moved pin shows every number
 * that moved rather than the first. Adding an observation to either strengthens
 * it and moves NO count here, which is why `mutations-skills.json` beside the
 * package is where those guards are held falsifiable.
 *
 *
 *
 *
 *
 * WIN-258 TRANCHE 5 — THE `memory` CANONICAL STORE (M2.3) adds 7 files and 89
 * cases to `packages/adapters/postgres-tenancy`, and nothing anywhere else:
 *
 *   memory-rows.test.ts                       24  the row mapping and the write
 *                                                 guards without a database:
 *                                                 which stored column is
 *                                                 trusted, which is refused,
 *                                                 and which value the CONTEXT
 *                                                 itself produces that the
 *                                                 schema will not hold
 *   memory-conformance.integration.test.ts     2  the shared scenario against
 *                                                 the two in-memory doubles and
 *                                                 against PostgreSQL, compared
 *                                                 step by step, plus a
 *                                                 non-vacuity case that pins
 *                                                 its shape
 *   memory-constraints.integration.test.ts    18  what the MIGRATIONS refuse and
 *                                                 `schema.prisma` does not say,
 *                                                 each stood beside the raw
 *                                                 statement the guard was
 *                                                 written from
 *   memory-rules.integration.test.ts          10  the four row rules, the two
 *                                                 cascades, ONE of the two port
 *                                                 contracts the real database
 *                                                 proves unhonourable, and the
 *                                                 two places the context's own
 *                                                 doubles are WRONG rather than
 *                                                 different
 *   memory-vectors.integration.test.ts         5  the two `vector(1536)` columns
 *                                                 the generated client cannot
 *                                                 name: what `set`, `keep` and
 *                                                 `clear` do to one, and the
 *                                                 OTHER unhonourable contract —
 *                                                 a search reading a column no
 *                                                 method on its port can write
 *   memory-transaction.integration.test.ts    12  failure injection from a
 *                                                 SECOND connection, a returned
 *                                                 error `Result` that COMMITS,
 *                                                 the three scope refusals and
 *                                                 the ambient read frame
 *   memory-statements.integration.test.ts     18  measured statement counts,
 *                                                 every pin taken over two rows
 *                                                 and over twenty
 *
 * 24 + 2 + 18 + 10 + 12 + 18 + 5 = 89, over 7 files, and every one of the seven
 * numbers is READ BACK from the counter in this file rather than tallied by
 * hand. Six of the seven need a real PostgreSQL and are run by the
 * `postgres-tenancy-repository` CI job; `memory-rows.test.ts` is not, because
 * neither the mapping nor the guards have a database in them — and it is the
 * only one of the seven that can reach a stored `kind` this binary cannot read,
 * since a container only ever reads rows this binary wrote.
 *
 * THE SEVENTH FILE EXISTS BECAUSE A MUTATION SURVIVED AND THE BUDGET THEN BIT.
 * `mutations-memory.json` M-M13 clears the vector on every update and survived
 * FIVE suites, because no read on either port returns an embedding; the three
 * cases that close it ask the column directly. Appending them to the rules suite
 * took it to 500 effective lines — the ADR M0.3 §6 ERROR threshold exactly — and
 * the seam the budget was pointing at is real: that file is about what the
 * SCHEMA decides for a row, and this one about the one thing in this store the
 * schema declares and the client cannot express.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 2 in the conformance suite, for the
 * reason every tranche before it gives: it is ONE scenario of sixty-odd
 * observations compared verbatim, so adding an observation strengthens the
 * differential and moves NO count here.
 * `packages/adapters/postgres-tenancy/mutations-memory.json` is where those
 * guards are held falsifiable instead.
 *
 * THE PACKAGE ROW THEREFORE MOVES 60 -> 67 FILES and 604 -> 693 CASES, and the
 * tree total 431 -> 438 files and 6520 -> 6609 cases. The adapters term of the
 * three-way identity carries all seven, because every added file is an
 * adapter's: 79 + 7 = 86, and 349 + 3 + 86 = 438.
 *
 * WIN-258 T5 — `privacy`, THE THIRTEENTH OWNER, adds SIX files and 75 cases, and
 * the shape of the split is the thing to read rather than the total. FIVE of the
 * six are integration suites and ONE is pure, which is the inverse of what a
 * two-table store would suggest: this context's guards are almost all about
 * CONCURRENCY and about the ABSENCE of a statement, and neither is observable
 * without a real database.
 *
 *   privacy-rows.test.ts                        25  the mapping and the guards,
 *                                                   with NO database — the only
 *                                                   place the unreadable-row
 *                                                   branches are reachable at
 *                                                   all, because two of them
 *                                                   cannot even be PLANTED: the
 *                                                   `status` column is a
 *                                                   PostgreSQL ENUM and `scopes`
 *                                                   and `stores` carry
 *                                                   `_json_root` CHECKs
 *   privacy-constraints.integration.test.ts     20  every migration-only
 *                                                   constraint, each proved
 *                                                   TWICE — once as the store's
 *                                                   pre-statement refusal with
 *                                                   the caller's transaction
 *                                                   surviving it, and once as
 *                                                   PostgreSQL's own error on a
 *                                                   row planted past the port
 *   privacy-rules.integration.test.ts           11  the four rules a
 *                                                   single-threaded double
 *                                                   cannot exhibit: two
 *                                                   transactions racing one
 *                                                   lease, the boundary instant
 *                                                   at which a lease lapses, and
 *                                                   the barrier proved sealed
 *                                                   THROUGHOUT a re-seal from a
 *                                                   second connection
 *   privacy-statements.integration.test.ts       9  the N+1 control, at three
 *                                                   aliases and at thirty —
 *                                                   which on this port is the
 *                                                   whole risk, because a seal
 *                                                   runs inside the transaction
 *                                                   holding the destruction open
 *   privacy-transaction.integration.test.ts      9  failure injection over a
 *                                                   SECOND client, plus the
 *                                                   three scope refusals
 *   privacy-conformance.integration.test.ts      2  the differential against
 *                                                   `InMemoryPrivacyRepository`
 *                                                                    total = 76
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 2 in the conformance suite, for the
 * reason every tranche before it gives: it is ONE scenario of forty-odd
 * observations compared verbatim, so adding an observation strengthens the
 * differential and moves NO count here.
 * `packages/adapters/postgres-tenancy/mutations-privacy.json` is where those
 * guards are held falsifiable instead.
 *
 * ALL FIVE OF THIS WAVE'S STORES LAND IN THIS ONE PACKAGE TOO, so its row is
 * the SUM of both waves: 20 + 6 + 6 + 7 + 6 + 6 + 9 + 7 + 8 + 6 + 7 + 6 + 7 + 7
 * + 5 + 6 = 119 files and
 * 199 + 59 + 60 + 65 + 72 + 66 + 83 + 77 + 97 + 62 + 89 + 76 + 97 + 100 + 52 + 56
 * = 1310 cases.
 * `providers` contributes 7 files / 77 cases, `conversations` 8 / 97, `skills`
 * 6 / 62 and `memory` 7 / 89, and no branch's own figure — 67/681, 68/701,
 * 66/666 or 67/693 — survives the merge. The tree total is 431 + 28 + 31 = 490
 * files and 6520 + 325 + 381 = 7226 cases. The adapters term of the three-way
 * identity carries all fifty-nine, because every added file is an adapter's:
 * 79 + 59 = 138, and 349 + 3 + 138 = 490.
 *
 * THE INTEGRATION/RUNNABLE SPLIT IS MEASURED, NOT CARRIED: 944 integration cases
 * across 99 files, 366 pure across 20, 944 + 366 = 1310.
 *
 * THE 25th CASE IN privacy-rows.test.ts EXISTS BECAUSE A MUTATION SURVIVED.
 * `mutations-privacy.json` M-P14 deletes the stored-scope LEVEL check and the
 * case that was there stayed green, because its witness had no `projectId` and
 * the NEXT clause refused it under the SAME code. The new case carries every id
 * a scope of any level could want, so only the level check can refuse it.
 *
 * WIN-258 T5, `jobs` — THE FOURTEENTH OWNER, in that SAME package a thirteenth
 * time. `Job` and `AgentApproval` are the two rows of ADR M0.3 §1 row 15, and
 * the store that writes them adds SEVEN suites and 97 cases:
 *
 *   jobs-rows.test.ts                       22 — the only one that runs without
 *                                                a container, and the only one
 *                                                that can reach the branches a
 *                                                container cannot: a container
 *                                                reads only rows THIS binary
 *                                                wrote
 *   jobs-rules.integration.test.ts          16 — rows an older binary wrote,
 *                                                planted by the ORM's CLI
 *   jobs-constraints.integration.test.ts    15 — a guard beside the raw
 *                                                statement it was written from
 *   jobs-statements.integration.test.ts     14 — the N+1 controls, each taken
 *                                                over a small fixture and one an
 *                                                order of magnitude larger
 *   jobs-transaction.integration.test.ts    13 — failure injection, the three
 *                                                scope refusals, and the
 *                                                `cost-monitoring` trap
 *   jobs-isolation.integration.test.ts      16 — what the DATABASE decides with
 *                                                no guard beside it
 *   jobs-conformance.integration.test.ts     1 — one scenario, two stores, one
 *                                                comparison
 *
 * THE 1 IN THE CONFORMANCE SUITE IS THE NUMBER TO WATCH, for the reason every
 * tranche before it gives: it is ONE scenario of eighty-odd observations
 * compared verbatim, so adding an observation strengthens the differential and
 * moves NO count here.
 * `packages/adapters/postgres-tenancy/mutations-jobs.json` is where those guards
 * are held falsifiable instead.
 *
 * FIVE OF THE ISOLATION SUITE'S SIXTEEN EXIST BECAUSE THE MUTATION SWEEP ASKED
 * FOR THEM — the three predicates of the dedupe lookup, the default thirty-day
 * listing window the conformance differential cannot ask for, the platform-wide
 * enumeration's `distinct` and its pending filter, the writes that must miss
 * another tenant's row, and the erasure's tenant narrowing. Every one closed a
 * guard the first sweep left standing with nothing red.
 *
 * ONE VOCABULARY BOUNDARY MOVED A CASE FROM THE CONTAINER SUITE TO THE PURE ONE.
 * `Job`'s invocation-type COLUMN carries the pre-cutover vendor name behind an
 * `@map`, `domain/invocation.ts` deliberately does not spell it and
 * `scripts/vocabulary-boundary.mjs` will not have this package spell it either —
 * so a row holding an unknown invocation type cannot be planted by raw SQL here,
 * and `readInvocationType` is proven in `jobs-rows.test.ts`, where the value goes
 * straight to the reader and no column is named at all.
 *
 * THE PACKAGE ROW THEREFORE MOVES 94 -> 101 FILES and 1005 -> 1102 CASES on this
 * step, and the tree total 465 -> 472 files and 6921 -> 7018 cases. The adapters
 * term of the three-way identity carries all seven, because every added file is
 * an adapter's: 113 + 7 = 120, and 349 + 3 + 120 = 472.
 *
 * 88 -> 95 FILES AND 929 -> 1024 CASES (WIN-258 T5, `files`). SEVEN files and
 * NINETY-FIVE cases, every number READ BACK from the counter in this file:
 *
 *   files-rows.test.ts                        21  the mapping boundary, and the
 *                                                 only one of the seven that
 *                                                 needs no container
 *   files-conformance.integration.test.ts      2  ONE scenario of forty-four
 *                                                 observations, plus its
 *                                                 negative control
 *   files-constraints.integration.test.ts     15  what the columns refuse, and
 *                                                 the two they ACCEPT
 *   files-rules.integration.test.ts           16  the five rules that live only
 *                                                 in the migrations, and the two
 *                                                 referential actions
 *   files-scope.integration.test.ts           31  one case per clause of every
 *                                                 scoped read, one wrong id each
 *   files-transaction.integration.test.ts      9  failure injection and the three
 *                                                 scope refusals
 *   files-statements.integration.test.ts       6  the measured counts
 *
 * 21 + 2 + 15 + 16 + 31 + 9 + 6 = 100, over 7 files. FIVE of those hundred were
 * added by the MUTATION SWEEP rather than written first, and they are the five
 * worth naming: four clause-isolation cases whose absence let a scoped read drop
 * its environment clause, its artifact-key clause or its thread clause and stay
 * green, and one unit case for a SQL NULL that JavaScript coerced to the right
 * answer. Six of the seven need a real
 * PostgreSQL and are run by the `postgres-tenancy-repository` CI job;
 * `files-rows.test.ts` is not, and it is the one that reaches the two
 * unreadable-row branches a container cannot — an unresolved ancestry, which the
 * schema's own foreign keys make unreachable from a live database, and a summed
 * byte total past 2^53, which would need nine petabytes of attachments in one
 * organization.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 2 in the conformance suite, for the
 * reason every tranche before it gives: it is ONE scenario compared verbatim, so
 * adding an observation strengthens the differential and moves NO count here.
 * `packages/adapters/postgres-tenancy/mutations-files.json` is where those
 * guards are held falsifiable instead.
 *
 * The tree total is 459 + 7 = 466 files and 6845 + 100 = 6945 cases. The adapters
 * term of the three-way identity carries all seven, because every added file is
 * an adapter's: 107 + 7 = 114, and 349 + 3 + 114 = 466.
 *
 * 119 -> 122 FILES AND 1310 -> 1358 CASES (WIN-258 T7, typed JSON columns and
 * projections). THREE files and FORTY-EIGHT cases, every number READ BACK from
 * the counter in this file:
 *
 *   json-columns.test.ts                   24  the census of all forty-nine
 *                                              JSONB columns, joined to
 *                                              schema.prisma, to the migrations'
 *                                              CHECK text and to the decoder
 *                                              symbols on disk; twelve of the
 *                                              twenty-four are the column maps
 *                                              reconciled model by model
 *   json-columns.integration.test.ts       17  the same census joined to
 *                                              `pg_constraint` on a live
 *                                              container, the malformed
 *                                              interiors written by
 *                                              `prisma db execute`, the five
 *                                              roots the database itself refuses
 *                                              and the projected SELECT lists
 *   outbox-store.test.ts                    3  `Event.payload`'s reader
 *
 * 24 + 17 + 3 = 44, plus FOUR added to the existing `agents-rows.test.ts` — the
 * params refusal this tranche found, the four-distinct-codes case, and the two
 * for `readObjectColumn` — is 48 over 3 new files.
 *
 * TWO CASES IN THIS BLOCK ARE ONE CASE OVER FORTY-NINE COLUMNS, DELIBERATELY.
 * The roots reconciliation and the decoder resolution were first written as
 * `test.each` over a computed table, which this census REFUSES and is right to:
 * a table it cannot count statically is a suite whose disappearing case it
 * cannot notice. They are loops inside one case, each assertion carrying the
 * column name so a failure still says which column failed.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 12 in the column-map reconciliation.
 * It is an array literal of MODEL NAMES, one per projected read, so adding a
 * projection adds a row here and moves this count — which is the point: a
 * selector nothing joins to the schema is the circular assertion the mutation
 * sweep found and killed.
 *
 * THAT DIMENSION ALONE would put the tree total at 490 + 3 = 493 files and
 * 7226 + 48 = 7274 cases, with the adapters term at 138 + 3 = 141. It is one of
 * FOUR that landed together, so the merged figure is neither this one nor any
 * other single dimension's; the arithmetic that stands is at the end of the
 * fourth block below.
 *
 * WIN-258 T7 — INDEXES, QUERY PLANS, PAGINATION AND COUNT TRUTH. Not a store:
 * every row this dimension touches already had one. What it adds is the
 * measurement no returned value can carry — the statements a read sent, the plan
 * PostgreSQL chose for one of them, and the rows that plan actually touched —
 * over fixtures of HUNDREDS of rows rather than two.
 *
 *   packages/adapters/postgres-tenancy   119 -> 125 files, 1310 -> 1393 cases
 *
 *   plans-probe.test.ts                         23  the measurement kit, measured,
 *                                                   and WITHOUT a container: a
 *                                                   defect in the kit is a defect
 *                                                   in every number the other
 *                                                   four report, and the failure
 *                                                   mode is silent — a filter
 *                                                   that discards too much reads
 *                                                   as a better statement count
 *   plans-agents.integration.test.ts            10  `pageBoundAgents` over 300
 *                                                   bindings, with the count
 *                                                   decoy in a SIBLING
 *                                                   environment of the same
 *                                                   project
 *   plans-conversations.integration.test.ts     13  `pageThreads` and `pageTurns`
 *                                                   over 300 rows each, and the
 *                                                   before/after of the index
 *                                                   this tranche added
 *   plans-cost.integration.test.ts               10  `pageBudgets`, the full
 *                                                   hydration that is deliberate,
 *                                                   pinned as a cost
 *   plans-tools.integration.test.ts              13  `pageExposures` over a
 *                                                   fixture built to TIE four
 *                                                   ways, which is what tranche
 *                                                   5's `mutations-tools.json`
 *                                                   M09 said it needed and did
 *                                                   not have
 *   plans-jobs.integration.test.ts               14  the approvals page, the ONE
 *                                                   read in the tree returning
 *                                                   TWO counts under TWO scopes
 *                                                   on purpose — and the
 *                                                   POSITIVE control, the one
 *                                                   hot read whose index was
 *                                                   already right
 *                                                                    total = 83
 *
 * THE 13th CASE IN plans-conversations EXISTS BECAUSE A MUTATION SURVIVED.
 * `mutations-plans.json` M-Q16 reverses the thread listing's direction, and the
 * case that was there proved the pages PARTITION the listing — which a reversed
 * order satisfies exactly as well as the right one. The added case walks every
 * page and demands the stamps come back non-increasing.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 23 in `plans-probe.test.ts`: it is
 * the only file here that needs no container, and it is deliberately the largest.
 * Four of the five suites report numbers the kit produced, so the kit is the one
 * thing in the dimension that cannot be checked by another part of it.
 *
 * THIS DIMENSION ALONE would put the tree total at 490 + 6 = 496 files and
 * 7226 + 83 = 7309 cases, with the adapters term at 138 + 6 = 144. Merged it is
 * neither; see the arithmetic at the end of the next block.
 *
 * WIN-258 TRANCHE 7 adds ONE file to this package, and the count is small for a
 * reason worth stating rather than apologising for.
 *
 *   upgrade-rollout.integration.test.ts        6  the store half of the
 *                                                 expand/contract rollout
 *                                                 acceptance
 *
 * THE TRANCHE IS MOSTLY NOT COUNTED HERE, and that is correct. Its other two
 * suites — `upgrade-guards.test.ts` and
 * `upgrade-expand-contract.integration.test.ts`, 26 and 9 cases — live in
 * `internal-packages/tenancy-database`, which is not a V1 package and has no
 * term in this census. They belong there because they rebuild the OLD releases'
 * Prisma clients from frozen schemas, and ADR M0.3 §4 puts the ORM in one home:
 * a suite that rebuilt a client from inside `packages/` would be a second place
 * the vendor is named, which `tenancy-prisma-only` refuses. The CI step that
 * runs the forward rehearsal runs all three, so nothing here is unrun.
 *
 * THE NUMBER TO WATCH IN THIS BLOCK is the 6. Four of the six are READS —
 * of a tenancy tree, an attachment, a policy and a thread written by a release
 * that predates three of the columns the stores now scope by — so they grow by
 * asserting more about the same rows rather than by adding cases. The guards
 * behind them are held falsifiable in
 * `packages/adapters/postgres-tenancy/mutations-upgrade-rollout.json`, whose
 * eighteen entries were all killed by a named case and whose one unreachable
 * branch is DECLARED there instead of counted.
 *
 * THIS DIMENSION ALONE would move the tree total by ONE file and SIX cases.
 *
 * THE MERGED ARITHMETIC, WHICH IS THE ONE THAT STANDS. Four T7 dimensions
 * landed together and every one of them moves this ONE package's row and no
 * other, so the figures compose by addition and no dimension's own total
 * survives the merge:
 *
 *   files   119 + 3 (JSON columns) + 6 (plans) + 3 (concurrency) + 1 (rollout)
 *             = 132
 *   cases  1310 + 48            + 83       + 36            + 6
 *             = 1483
 *
 * The tree total is 490 + 13 = 503 files and 7226 + 173 = 7399 cases. The
 * adapters term of the three-way identity carries all thirteen, because every
 * added file this census counts is an adapter's: 138 + 13 = 151, and
 * 349 + 3 + 151 = 503. The rollout dimension's other eight files are NOT in
 * that thirteen and cannot be: they are in `internal-packages/tenancy-database`,
 * which has no row here at all. The v1 ledger counts all twenty-eight.
 */
export const EXPECTED = Object.freeze({
  "packages/adapters/channel-slack": { files: 0, cases: 0 },
  "packages/adapters/clickhouse-observability": { files: 0, cases: 0 },
  "packages/adapters/durable-runtime": { files: 0, cases: 0 },
  "packages/adapters/model-router-providers": { files: 15, cases: 198 },
  "packages/adapters/notifier-email": { files: 0, cases: 0 },
  "packages/adapters/notifier-webhook": { files: 0, cases: 0 },
  "packages/adapters/objectstore-minio": { files: 0, cases: 0 },
  "packages/adapters/outbox": { files: 4, cases: 41 },
  "packages/adapters/postgres-tenancy": { files: 133, cases: 1485 },
  "packages/adapters/redis-cache": { files: 0, cases: 0 },
  "packages/adapters/redis-ratelimit": { files: 0, cases: 0 },
  "packages/adapters/redis-streams": { files: 0, cases: 0 },
  "packages/contexts/agents": { files: 25, cases: 515 },
  "packages/contexts/channels": { files: 15, cases: 269 },
  "packages/contexts/conversations": { files: 29, cases: 350 },
  "packages/contexts/cost-monitoring": { files: 21, cases: 352 },
  "packages/contexts/eventing": { files: 14, cases: 149 },
  "packages/contexts/files": { files: 15, cases: 134 },
  "packages/contexts/governance": { files: 31, cases: 609 },
  "packages/contexts/identity-access": { files: 23, cases: 318 },
  "packages/contexts/jobs": { files: 16, cases: 378 },
  "packages/contexts/memory": { files: 28, cases: 605 },
  "packages/contexts/observability": { files: 15, cases: 288 },
  "packages/contexts/privacy": { files: 15, cases: 254 },
  "packages/contexts/providers": { files: 27, cases: 375 },
  "packages/contexts/secrets": { files: 20, cases: 239 },
  "packages/contexts/skills": { files: 20, cases: 306 },
  "packages/contexts/tenancy": { files: 20, cases: 207 },
  "packages/contexts/tools": { files: 19, cases: 362 },
  "packages/kernel": { files: 4, cases: 60 },
});

/*
 * WIN-257 TRANCHE 3 DELTA (M2.2), the two missing transactional writes. One
 * package moves:
 *
 *   tenancy 16 -> 18 files, 146 -> 175 cases; 1025 -> 1054 total.
 *
 *   The two new files are `application/create-organization.test.ts` (11 cases)
 *   and `application/create-project.test.ts` (15 cases). `createOrganization`
 *   gets 3 happy-path cases, 6 refusals and 2 atomicity proofs;
 *   `createProject` gets 4 happy-path cases (including the two tenant-provenance
 *   cases), 8 refusals and 3 atomicity proofs. One existing suite is EDITED and
 *   gains cases: `application/tenancy-service.test.ts` 10 -> 13, the two
 *   creations reached through the published contract plus one refusal.
 *
 *   11 + 15 + 3 = 29, and 146 + 29 = 175. The FILE count moving by two is what
 *   makes the delta legible; the 29 is the part a file-count pin cannot see.
 *   Both were checked against what
 *   `pnpm --filter @platos/context-tenancy exec vitest run` prints —
 *   "Test Files 18 passed (18) / Tests 175 passed (175)" — and the per-file
 *   counts against the same command filtered to each file.
 *
 *   No other package moved. `apps/core-api` gained 11 composition cases in T2
 *   and is outside PACKAGE_ROOTS, so it does not appear here.
 */

/*
 * WIN-257 TRANCHE 4 DELTA (M2.2), the missing read models. TWO packages move:
 *
 *   identity-access 18 -> 20 files, 256 -> 284 cases.
 *   tenancy         18 -> 20 files, 175 -> 206 cases.
 *   1054 -> 1113 total.
 *
 *   identity-access +28: `domain/end-user.test.ts` (15) covers the listing rule
 *   and its caps, `application/list-end-users.test.ts` (9) covers the use case,
 *   and `application/identity-access-service.test.ts` goes 25 -> 29 for the
 *   contract-level page, its cross-tenant refusal and its two filter refusals.
 *   15 + 9 + 4 = 28.
 *
 *   tenancy +31: `domain/visibility.test.ts` (17) is the rule ported out of
 *   `operatorVisibleProjectWhere`, `application/operator-read-models.test.ts`
 *   (11) is the two read models over it, and
 *   `application/tenancy-service.test.ts` goes 13 -> 16 for the same reads
 *   through the published contract. 17 + 11 + 3 = 31.
 *
 *   Both were checked against what `pnpm --filter <package> exec vitest run`
 *   prints — "Test Files 20 passed (20) / Tests 284 passed (284)" for
 *   identity-access and "20 / 206" for tenancy — and each new file against the
 *   same command filtered to it. `apps/core-api` gained 3 more composition cases
 *   and is outside PACKAGE_ROOTS, so it does not appear here.
 */

/*
 * WIN-257 TRANCHE 5 DELTA (M2.2), the session-cookie exchange contract. ONE
 * package moves:
 *
 *   identity-access 20 -> 23 files, 284 -> 318 cases; 1113 -> 1147 total.
 *
 *   THREE files, and only ONE of them is new behaviour.
 *   `domain/session-cookie.test.ts` (28 cases) is the new one: the `__Host-`
 *   prefix rules, the TTL relation between a cookie and its session, rotation,
 *   clearing, and the directive brand. The other two are a SPLIT, forced by the
 *   line budget rather than chosen: adding the façade's cookie cases took
 *   `application/identity-access-service.test.ts` to 501 effective lines, one
 *   over the ADR M0.3 §6 hard limit. The budget was pointing at a real seam, so
 *   the file was split along it instead of the number being raised —
 *   `identity-access-service.end-users.test.ts` (4) and
 *   `identity-access-service.session-cookie.test.ts` (6) leave the original at
 *   exactly the 25 it held before this tranche.
 *
 *   28 + 4 + 6 = 38 gained, and 4 of those (the end-user façade cases) were
 *   already counted in T4's 284 — they MOVED file, they were not added. So the
 *   case delta is 28 + 6 = 34, and 284 + 34 = 318.
 *
 *   Checked against what `pnpm --filter @platos/context-identity-access exec
 *   vitest run` prints — "Test Files 23 passed (23) / Tests 318 passed (318)" —
 *   and each file against the same command filtered to it: 25, 4, 6, 28.
 *   `apps/core-api` gained 3 more composition cases (113 -> 116) and is outside
 *   PACKAGE_ROOTS.
 *
 *   The running total across T1-T5: 1000 at the branch point, +25 (T1), +29
 *   (T3), +59 (T4), +34 (T5) = 1147.
 *
 * WIN-257 T4 FOLLOW-UP, found while re-reading the port against the oracle. The
 * route orders BOTH halves of its landing query — `orderBy: { createdAt: "asc" }`
 * on the membership select AND on the nested `projects` select, the latter with
 * `take: 1`. `listVisibleProjects` ordered the memberships and left the projects
 * in store order, so the project an operator lands in would have depended on
 * insertion order. One case is added for the fix:
 *
 *   tenancy 206 -> 207 cases, files unchanged at 20; 1147 -> 1148 total.
 *
 *   `application/operator-read-models.test.ts` 11 -> 12, and one existing case
 *   in the same file changed its expected order rather than gaining a case:
 *   two projects built by `aProject` share the builder's epoch, so the id
 *   tiebreak now decides between them deterministically.
 */

/**
 * The sum the pinned rows must reach, pinned separately from the rows above so
 * the two can DISAGREE and be caught. They are computed differently — one by
 * this AST, one by the pinned table — and the refusal list is what keeps them
 * equal. If a change makes them diverge, one of the two numbers is a lie, and
 * the census should fail rather than quietly track the wrong one.
 *
 * WIN-258 T2 — A CORRECTION TO THIS COMMENT, made rather than left standing.
 * It used to read "the number `pnpm test:v1-packages` prints", and that has not
 * been true since tranche 1: the adapter's own `test` script excludes
 * `*.integration.test.ts` because the typecheck job has no Docker daemon, so
 * that command executes 25 cases FEWER than this sum at tranche 1 and 92 fewer
 * here. The census deliberately counts the suites a package SHIPS rather than
 * the suites one runner happens to execute (see the note beside the
 * postgres-tenancy row), and this constant is the sum of the rows under that
 * rule. The `postgres-tenancy-repository` CI job is what makes the excluded 92
 * run.
 *
 * 5931 -> 5998: the 67 identity-access cases of WIN-258 tranche 2, enumerated
 * file by file in the block beside the postgres-tenancy row.
 *
 * 5998 -> 6041: the 43 cases of WIN-258 tranche 3 — tenancy's other five ports
 * — enumerated file by file in the same block. That takes the count of cases
 * this census records and `pnpm test:v1-packages` does not execute from 92 to
 * 128, all of them in the one adapter the `postgres-tenancy-repository` job
 * runs.
 *
 * 6041 -> 6115: the outbox's 41 and the 33 of tranche 4.
 *
 * 6115 -> 6175: the 60 cases of WIN-258 tranche 5 — the `agents` canonical store
 * — enumerated file by file in the block beside the postgres-tenancy row, every
 * number there read back from the counter in this file.
 *
 * 6299 -> 6520: the 221 cases of WIN-258 tranche 5's next three canonical
 * stores — `channels`' 72, `governance`'s 66 and `secrets`' 83 — each
 * enumerated file by file in the block beside the postgres-tenancy row.
 *
 * 6520 -> 6756: the 77 cases of `providers`, the 97 of `conversations` and the
 * 62 of `skills`, each enumerated file by file in the blocks above. Three of
 * `conversations`' eight files exist only because `max-file-lines` bit at the
 * HARD error, so that file count moved by eight where the work was five suites'
 * worth — which is the kind of thing a census states rather than absorbs.
 *
 * The cases this census records that `pnpm test:v1-packages` does not execute
 * are the ones whose file name carries `.integration.`, which the package's own
 * `test` script excludes. MEASURED over this tree: 598 cases across
 * 67 files, all of them in `packages/adapters/postgres-tenancy`.
 *
 * THIS SENTENCE SAID "183 cases across 20 files" AND THE TREE SAID 265 ACROSS
 * 31, at the base of this wave and before any of these three stores existed.
 * Only the `governance` branch moved it, and it moved it by its own contribution
 * alone; the `channels` and `secrets` branches left the stale figure standing.
 * It is corrected to the merged measurement rather than carried, because a count
 * of cases stated in prose beside an asserted one is exactly the drift this file
 * exists to catch.
 *
 * 6520 -> 6597: the 77 cases of WIN-258 tranche 5's `providers` canonical store,
 * enumerated file by file in the block beside the postgres-tenancy row. Six of
 * its seven suites carry `.integration.` in the name, so the cases this census
 * records and `pnpm test:v1-packages` does not execute go from 422 over 49 files
 * to 482 over 55; the seventh, `providers-rows.test.ts`, runs in the ordinary
 * package test script for the reason the other three row suites do — it has no
 * database in it, and it reaches the mapping branches a container suite cannot,
 * since a container only ever reads rows this binary wrote.
 *
 * +83: the cases of WIN-258 tranche 7's indexes/query-plans/
 * pagination/count-truth dimension, enumerated file by file in the block beside
 * the postgres-tenancy row. FIVE of its six suites carry `.integration.` in the
 * name and need a real PostgreSQL, so the cases this census records and
 * `pnpm test:v1-packages` does not execute go from 598 over 67 files to 658
 * over 72. The sixth, `plans-probe.test.ts`, runs in the ordinary package test
 * script and is deliberately the LARGEST single file of the six: it is the
 * measurement kit every other suite in the dimension reports numbers from, so it
 * is the one part that cannot be checked by another part of it, and a container
 * is exactly what it must not need in order to be skippable.
 */
/*
 * WIN-258 T7, concurrency / pooling / transaction boundaries — +36.
 *
 * THIRTY-SIX CASES OVER THREE NEW SUITES AND TWO EDITED ONES, all inside
 * `packages/adapters/postgres-tenancy`, whose row goes 119/1310 -> 122/1346:
 *
 *   pooling.integration.test.ts                 11  the datasource URL asked of
 *                                                   a real server: the query
 *                                                   parameter shape reporting
 *                                                   '0', the options shape
 *                                                   reporting its three values,
 *                                                   the caller's own options
 *                                                   surviving, and three
 *                                                   refusals — 57014, 55P03 and
 *                                                   a terminated session — each
 *                                                   with its negative control,
 *                                                   plus the pool's P2024
 *   optimistic-concurrency.integration.test.ts   6  the unfenced lost update
 *                                                   RUN rather than described,
 *                                                   the stale writer refused
 *                                                   after a measured wait, the
 *                                                   loser's earlier work rolled
 *                                                   back, the insert race, and
 *                                                   the two controls
 *   transaction-boundaries.integration.test.ts   9  the returned-error-commits
 *                                                   trap and the bridge that
 *                                                   closes it, failure
 *                                                   injection, the aborted
 *                                                   transaction that reports a
 *                                                   successful commit, and
 *                                                   isolation inside the
 *                                                   ambient frame
 *                                                        subtotal = 26
 *
 *   client.test.ts                              +9  six for the server-timeout
 *                                                   shape, two for the P2025
 *                                                   classification the M26
 *                                                   sweep proved missing, and
 *                                                   two more rows on the
 *                                                   positive-integer table,
 *                                                   less the one case the pool
 *                                                   settings and the server
 *                                                   settings were split out of
 *   secrets-rules.integration.test.ts           +1  the divergence case became
 *                                                   two: both stores keying on
 *                                                   the pair, and both refusing
 *                                                   a write that thinks the key
 *                                                   is free
 *                                                        subtotal = 10
 *
 * 26 + 10 = 36, and THIS DIMENSION ALONE would read 1310 + 36 = 1346. NO OTHER
 * PACKAGE MOVES: the fence, the scoped DELETE and the domain refusal are edits
 * in place in `packages/contexts/secrets`, whose own suites still number what
 * they did.
 *
 * The three-way file identity holds, on the MERGED figure rather than this
 * dimension's: packages.contexts.test 349 + packages.kernel.test 3 +
 * packages.adapters.test 151 = 503, which is this census's own totalFiles. The
 * adapters term moved 138 -> 151, of which THREE are this dimension's suites and
 * the other ten belong to its three siblings; the v1 ledger counts the same
 * thirteen.
 *
 * The cases this census records that `pnpm test:v1-packages` does not execute
 * are the ones whose file name carries `.integration.`; all three new suites do,
 * so that measured figure moves by 26 and `client.test.ts`'s nine stay runnable.
 */

/*
 * +6: the cases of WIN-258 tranche 7's store-level rollout
 * rehearsal. All six carry `.integration.` in the name, so `pnpm
 * test:v1-packages` executes none of them — the file is one container and two
 * rebuilt old clients — and the cases this census records but that script does
 * not run go up by exactly six. The tranche's other 35 cases are not in this
 * total at all: they live in `internal-packages/tenancy-database`, which has no
 * row in this census, for the reason the postgres-tenancy block gives.
 */

/*
 * THE MERGED RUNTIME TOTAL, WHICH IS THE ONE THIS CONSTANT HOLDS. The four T7
 * dimensions land on the SAME adapter row and on no other, so their deltas
 * compose by addition and each block above states its own contribution rather
 * than a total: 7226 + 48 + 83 + 36 + 6 = 7399.
 *
 * The runnable/integration split composes the same way. Runnable goes
 * 366 + 31 + 23 + 9 + 0 = 429; the cases this census records that
 * `pnpm test:v1-packages` does not execute go 944 + 17 + 60 + 27 + 6 = 1054,
 * over 99 + 1 + 5 + 3 + 1 = 109 files. THE CONCURRENCY DIMENSION IS THE ONE TO
 * READ TWICE: nine of its thirty-six are runnable, in `client.test.ts`, and the
 * other twenty-seven are not — twenty-six in its three new container suites and
 * ONE added to `secrets-rules.integration.test.ts`, whose name carries
 * `.integration.` and which therefore lands on that side however small the
 * addition. 429 + 1054 = 1483 is the whole postgres-tenancy row and
 * 23 + 109 = 132 is its file count, both of which the EXPECTED table above
 * states independently. The `postgres-tenancy-repository` CI job running 109
 * files / 1054 tests is therefore a check on this split derived without it.
 */
/*
 * WIN-259 (M2.4) SECRET PROJECTION, +16 and one new FILE, all in
 * `packages/kernel`: 44 -> 60 cases, 3 -> 4 files, and 7399 -> 7415.
 *
 * The file is `src/vo/redaction.test.ts`, the colocated suite for the redactor
 * `ports/logger.ts` has always described and never had. Its sixteen cases are
 * TWO-SIDED by design and that is why there are sixteen rather than six: every
 * case that pins a hidden field is paired with one that pins a field which must
 * SURVIVE, because a redactor that hides everything passes a one-sided suite
 * and deletes the log.
 *
 * Measured with `pnpm --filter @platos/kernel exec vitest run` — "Test Files 4
 * passed (4) / Tests 60 passed (60)" — and the file on its own prints 16.
 *
 * `apps/core-api` gained 9 cases (116 -> 125) in
 * `src/runtime/log-redaction.test.ts`, the suite that joins the classifier to
 * the canonical Prisma schema, and is outside PACKAGE_ROOTS so it moves no pin
 * here. It is named because it is the half of the evidence that is NOT in this
 * census, and a reader counting 16 should know 9 more exist.
 */
/*
 * WIN-259 (M2.4) WRITE-ONLY INPUTS, +13 and one new FILE, all in
 * `packages/contexts/secrets`: 162 -> 175 cases, 16 -> 17 files, and
 * 7415 -> 7428.
 *
 * The file is `application/write-only-inputs.test.ts`. Its thirteen cases are
 * the WRITE half of the boundary: four that a mutating command cannot be
 * written down (JSON, string coercion, spreading, enumeration), six that a bare
 * string is refused with its own code and leaves no row and no audit, two that
 * tell the carrier refusal apart from the material refusal, and one that
 * DECLARES what the carrier check cannot see rather than overclaiming it.
 *
 * `packages/contexts/providers` moves NO pin and that is the finding worth
 * recording. Its double now refuses a bare string the way the real vault does,
 * so every existing write-path case there became a witness for the wrapping at
 * the providers/secrets seam without one case being added. Measured: `pnpm
 * --filter @platos/context-providers exec vitest run` prints 27 files / 375
 * tests before and after.
 *
 * Measured with `pnpm --filter @platos/context-secrets exec vitest run` —
 * "Test Files 17 passed (17) / Tests 175 passed (175)" — and the new file on
 * its own prints 13.
 */
/*
 * WIN-259 (M2.4) DENIED-READ EVIDENCE, +11 and one new FILE, again all in
 * `packages/contexts/secrets`: 175 -> 186 cases, 17 -> 18 files, and
 * 7428 -> 7439.
 *
 * The file is `application/denied-read-audit.test.ts`. `DENIED` has been in
 * `CREDENTIAL_AUDIT_OUTCOMES` since this context was written and a grep of the
 * package found it declared and never produced -- `recordAudit` defaulted to
 * `SUCCESS` and no caller passed anything else -- so a refused read left no
 * trace at all. Seven cases pin the row that now exists; THREE DECLARE A
 * SILENCE (an unminted grant, a credential that does not resolve, a PLAIN
 * variable) because each is a place the trail is deliberately empty and a
 * reader counting rows has to know which emptiness is honest; one pins that the
 * evidence path cannot change the answer the caller receives.
 *
 * Measured with `pnpm --filter @platos/context-secrets exec vitest run` --
 * "Test Files 18 passed (18) / Tests 186 passed (186)" -- and the new file on
 * its own prints 11.
 */
/*
 * WIN-259 (M2.4) ON REAL POSTGRESQL, +1 case and +1 FILE in
 * `packages/adapters/postgres-tenancy`: 1483 -> 1484 cases, 132 -> 133 files,
 * and 7439 -> 7440.
 *
 * THE CASE IS `a DENIED outcome reaches PostgreSQL, and commits in a
 * transaction of its OWN`, in `secrets-rules.integration.test.ts`. It exists
 * because until this branch NO ROW WITH THAT OUTCOME HAD EVER REACHED THE
 * DATABASE: the value was declared in `CREDENTIAL_AUDIT_OUTCOMES` and never
 * produced, and the in-memory double stores whatever string it is handed. That
 * is the shape of the failure this project has already recorded — the doubles
 * mint values the canonical store refuses, and every use-case suite passes.
 * Read from the MIGRATION rather than from `schema.prisma`: `outcome` is TEXT
 * NOT NULL with no CHECK, which is a fact about an ABSENCE that the generated
 * types cannot show.
 *
 * THE FILE IS `secrets-variable-fence.integration.test.ts`, AND IT ADDS NO
 * CASE. It is the split scripts/arch/max-file-lines.test.mjs pre-registered in
 * WIN-258 T7's own band entry — "A further case takes it past 460 and the split
 * to make then is the fence's own `describe`, moved whole" — carried out
 * verbatim. The `describe` moved unedited, so the case delta is 1 (the DENIED
 * case) and not 1 plus the fence's four.
 *
 * Neither is executed by `pnpm test:v1-packages`: both carry `.integration.` in
 * the name, so this census records them and that script runs neither. They run
 * on the Mac mini under `pnpm test:postgres-tenancy:integration`.
 */
/*
 * WIN-259 (M2.4) THE SECRET REFERENCE, +53 cases and +2 FILES, all in
 * `packages/contexts/secrets`: 186 -> 239 cases, 18 -> 20 files, and
 * 7440 -> 7493.
 *
 * THE TWO FILES SPLIT BY WHAT CAN BE PROVED WITHOUT A CIPHER AND WHAT CANNOT,
 * which is why there are two rather than one.
 *
 * `domain/secret-handle.test.ts` carries 27 and proves only STRUCTURE: the two
 * label strings byte for byte, the claims body byte for byte, the base64url
 * codec at every length modulo 3, the wire form's field count and scheme, and
 * the lifetime rule at its boundary millisecond. It deliberately proves NOTHING
 * about opacity or environment binding, because neither is a property of that
 * file — both live in the cipher's key derivation and its AAD, and asserting
 * them there would have compared the classifier to itself.
 *
 * `application/secret-handles.test.ts` carries 26 and proves the four
 * properties that only exist once a cipher and a store are involved, each
 * joined to something the assertion does not control: opacity against the
 * plaintext, the name and the provider; environment binding against a SECOND
 * fully-built environment whose reference is carried across by hand; revision
 * pinning against a rotation the real `rotateCredential` performed; and the
 * audit trail against the store's own rows in BOTH directions.
 *
 * `packages/contexts/providers` moves no pin again, for the same reason it did
 * not move for write-only inputs: a reference is a VALUE and adds no port a
 * peer implements.
 *
 * Measured with `pnpm --filter @platos/context-secrets exec vitest run` --
 * "Test Files 20 passed (20) / Tests 239 passed (239)" -- and the two new files
 * on their own print 27 and 26.
 */
/*
 * WIN-259 (M2.4) THE REFERENCE AGAINST REAL POSTGRESQL, +1 case and NO file, in
 * `packages/adapters/postgres-tenancy`: 1484 -> 1485 cases, 133 files
 * unchanged, and 7493 -> 7494.
 *
 * THE CASE IS `an audit row naming a credential from ANOTHER environment is
 * refused by the database`, appended to `secrets-rules.integration.test.ts`.
 * The denied-exchange path states a limit in prose -- a reference that does not
 * open under the presented grant's environment leaves no trace, because the
 * trail may only name credentials that exist here -- and this case turns the
 * second half of that sentence into a fact about the database.
 *
 * `inMemorySecretsStore` keys its audit rows by nothing and accepts the pair
 * happily, so all 26 exchange cases in `packages/contexts/secrets` pass either
 * way. Only `CredentialAudit_credentialId_environmentId_fkey` -- a COMPOSITE
 * key that lives in the migration and in neither the generated types nor any
 * port signature -- refuses it. That is the shape this project has already been
 * bitten by, and it is why the case is here rather than beside the use case.
 *
 * It is NOT executed by `pnpm test:v1-packages`: the file carries
 * `.integration.` in its name. It runs on the Mac mini under
 * `pnpm test:postgres-tenancy:integration`.
 */
export const EXPECTED_RUNTIME_TOTAL = 7494;

/** Every case-declaring package directory, in byte order. */
export function listPackages(root = repositoryRoot) {
  const found = [];
  for (const packageRoot of PACKAGE_ROOTS) {
    const absolute = join(root, packageRoot);
    if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (statSync(join(absolute, "package.json"), { throwIfNoEntry: false })?.isFile()) {
      found.push(packageRoot);
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) found.push(`${packageRoot}/${entry.name}`);
    }
  }
  return found.sort();
}

/** Every `*.test.ts` beneath one package, repo-relative and in byte order. */
export function listTestFiles(root = repositoryRoot, packagePath) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
        found.push(relative(root, child).split("\\").join("/"));
      }
    }
  };
  walk(join(root, packagePath));
  return found.sort();
}

/** See through `as const`, `satisfies` and parentheses to the real table. */
function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** The `it`/`test`/`describe` chain a call site is rooted in, or null. */
function calleeChain(node) {
  let current = node.expression;
  let expandedBy = null;
  let templated = false;
  let invoked = false;

  if (ts.isCallExpression(current)) {
    // `it.each([...])("name", fn)` — the tail call's callee is the `.each` call.
    expandedBy = current.arguments[0] ? unwrap(current.arguments[0]) : null;
    current = current.expression;
    invoked = true;
  } else if (ts.isTaggedTemplateExpression(current)) {
    // `it.each`table`("name", fn)` — rows are in the template, not an array.
    templated = true;
    current = current.tag;
    invoked = true;
  }

  const modifiers = [];
  while (ts.isPropertyAccessExpression(current)) {
    modifiers.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  return { root: current.text, modifiers, expandedBy, templated, invoked };
}

/**
 * Where a case may be declared: the file body, or a `describe`/`suite` callback.
 * Anywhere else — a helper, a loop body, a `beforeEach` — makes the declaration
 * site and the runtime count different numbers, which the census refuses.
 */
function declarationSiteIsCountable(node) {
  const iterations = new Set([
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
  ]);

  for (let current = node.parent; current; current = current.parent) {
    if (iterations.has(current.kind)) return false;
    if (ts.isSourceFile(current)) return true;
    if (!ts.isFunctionLike(current)) continue;

    // The nearest enclosing function decides. It is countable only when it is
    // the body of a group call.
    const call = current.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(current)) return false;
    const chain = calleeChain(call);
    if (!chain || !GROUP_ROOTS.has(chain.root)) return false;
    if (chain.modifiers.some((modifier) => EXPANDING_MODIFIERS.has(modifier))) return false;
  }
  return true;
}

/** Cases, non-executing cases and refusals declared by one test file. */
export function countFile(virtualPath, text) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const refusals = [];
  let cases = 0;
  let nonExecuting = 0;

  const refuse = (node, reason) => refusals.push({ path: virtualPath, line: at(node), reason });

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node);
      const expanding = chain?.modifiers.some((modifier) => EXPANDING_MODIFIERS.has(modifier)) ?? false;

      // `it.each([...])(...)` is TWO nested calls. The inner one supplies the
      // table and declares nothing; only the outer, invoked one is a case.
      // Counting both is how the first run of this census double-reported.
      if (chain && expanding && !chain.invoked) {
        // deliberately nothing
      } else if (chain && GROUP_ROOTS.has(chain.root) && expanding) {
        refuse(node, `${chain.root}.each multiplies every case inside it; the census cannot count it exactly`);
      } else if (chain && CASE_ROOTS.has(chain.root)) {
        if (!declarationSiteIsCountable(node)) {
          refuse(node, `${chain.root}() is declared inside a loop or a non-describe callback`);
        } else if (!expanding) {
          cases += 1;
          if (chain.modifiers.some((modifier) => NON_EXECUTING_MODIFIERS.has(modifier))) nonExecuting += 1;
        } else if (chain.templated || !chain.expandedBy || !ts.isArrayLiteralExpression(chain.expandedBy)) {
          refuse(node, `${chain.root}.each over a table that is not an array literal has no statically visible row count`);
        } else {
          const rows = chain.expandedBy.elements.length;
          if (chain.expandedBy.elements.some((element) => ts.isSpreadElement(element))) {
            refuse(node, `${chain.root}.each over a spread table has no statically visible row count`);
          } else {
            cases += rows;
            if (chain.modifiers.some((modifier) => NON_EXECUTING_MODIFIERS.has(modifier))) nonExecuting += rows;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { cases, nonExecuting, refusals };
}

/** The live census: one row per package, plus totals and every refusal. */
export function census(root = repositoryRoot) {
  const packages = {};
  const refusals = [];
  let totalFiles = 0;
  let totalCases = 0;
  let totalNonExecuting = 0;

  for (const packagePath of listPackages(root)) {
    const files = listTestFiles(root, packagePath);
    let cases = 0;
    let nonExecuting = 0;
    for (const file of files) {
      const counted = countFile(file, readFileSync(join(root, file), "utf8"));
      cases += counted.cases;
      nonExecuting += counted.nonExecuting;
      refusals.push(...counted.refusals);
    }
    packages[packagePath] = { files: files.length, cases };
    totalFiles += files.length;
    totalCases += cases;
    totalNonExecuting += nonExecuting;
  }

  return { packages, totalFiles, totalCases, nonExecuting: totalNonExecuting, refusals };
}

/** Every way the live census can disagree with what is pinned. */
export function checkCensus(root = repositoryRoot, expected = EXPECTED) {
  const live = census(root);
  const problems = [];

  for (const [packagePath, counts] of Object.entries(live.packages)) {
    const pinned = expected[packagePath];
    if (!pinned) {
      problems.push(`UNPINNED ${packagePath} has ${counts.files} test file(s) and ${counts.cases} case(s) but no pinned row`);
      continue;
    }
    if (counts.files !== pinned.files) {
      problems.push(`FILES    ${packagePath} has ${counts.files} test file(s); ${pinned.files} pinned`);
    }
    if (counts.cases !== pinned.cases) {
      const direction = counts.cases < pinned.cases ? "LOST" : "GAINED";
      problems.push(
        `CASES    ${packagePath} has ${counts.cases} case(s); ${pinned.cases} pinned ` +
          `(${direction} ${Math.abs(counts.cases - pinned.cases)}) — update the delta comment in ` +
          `scripts/arch/test-case-census.mjs, never the number alone`,
      );
    }
  }
  for (const packagePath of Object.keys(expected)) {
    if (!(packagePath in live.packages)) problems.push(`MISSING  ${packagePath} is pinned but is not a package`);
  }
  for (const refusal of live.refusals) {
    problems.push(`REFUSED  ${refusal.path}:${refusal.line} — ${refusal.reason}`);
  }
  if (live.nonExecuting !== 0) {
    problems.push(`SKIPPED  ${live.nonExecuting} declared case(s) carry .skip or .todo; the pin requires 0`);
  }
  // Only meaningful for the real pin: a fixture declares its own small census
  // and has no relationship to what the repository's suites print.
  const pinnedTotal = Object.values(expected).reduce((sum, row) => sum + row.cases, 0);
  if (expected === EXPECTED && pinnedTotal !== EXPECTED_RUNTIME_TOTAL) {
    problems.push(
      `RUNTIME  the pinned rows sum to ${pinnedTotal} but EXPECTED_RUNTIME_TOTAL is ${EXPECTED_RUNTIME_TOTAL}; ` +
        `one of them no longer matches what \`pnpm test:v1-packages\` prints`,
    );
  }

  return { live, problems };
}

function main() {
  const result = checkCensus();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }

  const { live, problems } = result;
  process.stdout.write(
    `test-case-census: ${live.totalCases} case(s) across ${live.totalFiles} file(s) in ` +
      `${Object.keys(live.packages).length} V1 package(s)\n`,
  );
  for (const problem of problems) process.stdout.write(`${problem}\n`);

  if (problems.length === 0) {
    process.stdout.write(
      `ok: every package's test FILE and CASE count matches its pin, no case is skipped or todo, and no ` +
        `construct was refused as uncountable. Deleting an it() block inside a retained file now fails here.\n`,
    );
  } else {
    process.stdout.write(`\n${problems.length} test-case-census problem(s).\n`);
  }
  process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("test-case-census.mjs")) main();
