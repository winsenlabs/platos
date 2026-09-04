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
 */
export const EXPECTED = Object.freeze({
  "packages/adapters/channel-slack": { files: 0, cases: 0 },
  "packages/adapters/clickhouse-observability": { files: 0, cases: 0 },
  "packages/adapters/durable-runtime": { files: 0, cases: 0 },
  "packages/adapters/model-router-providers": { files: 0, cases: 0 },
  "packages/adapters/notifier-email": { files: 0, cases: 0 },
  "packages/adapters/notifier-webhook": { files: 0, cases: 0 },
  "packages/adapters/objectstore-minio": { files: 0, cases: 0 },
  "packages/adapters/outbox": { files: 0, cases: 0 },
  "packages/adapters/postgres-tenancy": { files: 0, cases: 0 },
  "packages/adapters/redis-cache": { files: 0, cases: 0 },
  "packages/adapters/redis-ratelimit": { files: 0, cases: 0 },
  "packages/adapters/redis-streams": { files: 0, cases: 0 },
  "packages/contexts/agents": { files: 25, cases: 515 },
  "packages/contexts/channels": { files: 0, cases: 0 },
  "packages/contexts/conversations": { files: 0, cases: 0 },
  "packages/contexts/cost-monitoring": { files: 21, cases: 352 },
  "packages/contexts/eventing": { files: 14, cases: 149 },
  "packages/contexts/files": { files: 15, cases: 134 },
  "packages/contexts/governance": { files: 0, cases: 0 },
  "packages/contexts/identity-access": { files: 17, cases: 231 },
  "packages/contexts/jobs": { files: 16, cases: 378 },
  "packages/contexts/memory": { files: 28, cases: 605 },
  "packages/contexts/observability": { files: 15, cases: 288 },
  "packages/contexts/privacy": { files: 15, cases: 254 },
  "packages/contexts/providers": { files: 21, cases: 283 },
  "packages/contexts/secrets": { files: 16, cases: 162 },
  "packages/contexts/skills": { files: 20, cases: 306 },
  "packages/contexts/tenancy": { files: 16, cases: 146 },
  "packages/contexts/tools": { files: 0, cases: 0 },
  "packages/kernel": { files: 3, cases: 44 },
});

/**
 * The number `pnpm test:v1-packages` prints, pinned separately from the sum
 * above so the two can DISAGREE and be caught. They are computed differently —
 * one by this AST, one by vitest — and the refusal list is what keeps them
 * equal. If a change makes them diverge, one of the two numbers is a lie, and
 * the census should fail rather than quietly track the wrong one.
 */
export const EXPECTED_RUNTIME_TOTAL = 3847;

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
