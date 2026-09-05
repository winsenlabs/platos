import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ERROR_THRESHOLD,
  SELECTORS,
  WARNING_THRESHOLD,
  auditMaxFileLines,
  effectiveLineCount,
} from "./max-file-lines.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = [];

after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function fixture(path, source) {
  const root = mkdtempSync(join(tmpdir(), "platos-max-lines-"));
  fixtures.push(root);
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
  return root;
}

function codeLines(count) {
  return Array.from({ length: count }, (_unused, index) => `export type Line${index} = ${index};`).join("\n");
}

test("selectors and thresholds are the exact accepted WIN-251 max-file-lines slice", () => {
  assert.deepEqual(SELECTORS, [
    "packages/kernel/**",
    "packages/contexts/**",
    "packages/adapters/**",
    "apps/core-api/src/transports/**",
  ]);
  assert.equal(WARNING_THRESHOLD, 400);
  assert.equal(ERROR_THRESHOLD, 500);
});

test("effective lines exclude blank and comment-only lines without stripping comment markers in strings", () => {
  const source = [
    "",
    "// comment",
    "/* block",
    " * comment",
    " */",
    "export const url = 'https://example.test/path'; // trailing comment",
    "export const marker = '/* not a comment */';",
    "/* before */ export const value = 1;",
    "",
  ].join("\n");
  assert.equal(effectiveLineCount(source), 3);
});

test("400 effective lines pass, 401 warn, 500 warn, and 501 hard-fail", () => {
  for (const [count, severity] of [[400, null], [401, "warning"], [500, "warning"], [501, "error"]]) {
    const root = fixture("packages/contexts/tools/application/threshold.ts", codeLines(count));
    const result = auditMaxFileLines(root, { selectors: ["packages/contexts/**"] });
    assert.equal(result.fileCount, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.findings[0]?.severity ?? null, severity, `effective line count ${count}`);
    assert.equal(result.findings[0]?.effectiveLines ?? count, count);
  }
});

test("comment and blank padding cannot mutate a 400-line file into a warning", () => {
  const padded = `${codeLines(400)}\n${Array.from({ length: 150 }, () => "// padding").join("\n")}\n\n`;
  const root = fixture("apps/core-api/src/transports/rest/padded.ts", padded);
  const result = auditMaxFileLines(root);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.findings, []);
});

test("the live selectors scan an exact nonzero source census", () => {
  const result = auditMaxFileLines(repositoryRoot);
  // 74 -> 263 -> 328 -> 372 -> 427 -> 478 -> 555 -> 618 -> 666 -> 714 -> 781 ->
  // 837 -> 879 -> 962 -> 970, and then 970 -> 974 -> 1048 once the selector
  // widens. WIN-256 made packages/kernel and four contexts
  // real, so the ADR M0.3 §6 file-size budget now applies to real production
  // source rather than to placeholders. Every one of the 263 is inside the
  // 400/500-line budget. The chain above stopped at 781 while the pin below had
  // already moved four times past it; it is carried through to the pinned number
  // here rather than left short.
  //
  // +65: the same issue makes `providers` real. The budget bit once while it was
  // being written — one test module reached 441 effective lines — and the answer
  // was to split it along the seam the budget was pointing at, into a write-path
  // suite and a read-path suite, rather than to raise the number.
  //
  // +44: the same issue makes `eventing` real. Its 44 files are the budget's own
  // argument: they are a refactor of one 587-line Nest service
  // (apps/agent/src/mcp-platform/events.service.ts) that was already over the
  // 500-line hard error, and no file in the replacement exceeds 200.
  //
  // +55: the same issue makes `skills` real. Every one is inside the budget, and
  // the largest is the in-memory repository double at roughly 330 counted lines
  // — a deliberate consequence of splitting the context into 14 domain modules
  // and 13 named use cases rather than a registry service, which is the shape §6
  // exists to force.
  //
  // +77: the same issue makes `memory` real. The budget bit once again, at 446
  // effective lines, and the answer was the same one — the module was the
  // knowledge-graph suite covering both the write use cases and the read ones,
  // and it split into `knowledge-graph.test.ts` and `graph-queries.test.ts`
  // along exactly the seam the two modules under test already had.
  //
  // +63: the same issue makes `cost-monitoring` real. The budget bit once
  // again, at 412 effective lines in the alerting suite, and the answer was
  // again to split along the seam it pointed at — recording a crossing is one
  // durable decision and sending one is another, and they were only in one file
  // because they were written in one sitting.
  //
  // +51: the same issue makes `jobs` real. Its production source is split across
  // `execute-job.ts`, `register-job.ts` and the two approval use cases rather
  // than reproducing the 571-line `job-execution.service.ts` it replaces, which
  // is the §6 corollary about named sub-use-case files doing its job.
  //
  // +48: the same issue makes `privacy` real (ADR M0.3 §1 row 18). The erasure
  // orchestration is split into named use-case modules rather than one service,
  // and NONE of its 48 files reaches the 400-line warning band — measured over
  // the integrated tree, not carried from the branch, which is why the warning
  // list below is unchanged at three files.
  //
  // +56: the same issue makes `tools` real, and it is the budget's largest single
  // test: the three source files it replaces are 1,644, 845 and 587 lines, and
  // §6 names the first of those as the failure the budget exists to prevent. The
  // 1,644-line executor became a routing rule, a permission rule, a transport
  // resolution and one use case with a single exit — 256 effective lines, the
  // largest non-test module in the package. 55 of the 56 arrived with the
  // context; the 56th is contracts/operator-gate.test.ts, which exists BECAUSE
  // this budget bit: twenty-nine gate cases written inside contracts/index.test.ts
  // took that file to the top of the warning band, and moving them out is why
  // that delta is 1 and not 0.
  //
  // +42: the same issue makes `channels` real — 27 source and 15 test files,
  // replacing its 4 released placeholders in place. The budget did NOT bite
  // anywhere in that tree: its largest file is contracts/channels-contract.test.ts
  // at 280 effective lines and its largest production module is
  // application/channels-contract.ts at 224, so `channels` adds NO file to the
  // warning list below and none anywhere near the 500-line failure line. Its
  // branch went on to say `findings` was "empty, not merely free of errors",
  // which was true of the tree it measured and is NOT true of this one — the
  // four files named below are findings — so that half of the sentence is
  // dropped rather than carried.
  //
  // +83: the same issue makes `governance` real. The layout was designed for the
  // ceiling up front — the extraction source's `eval.service.ts` is 678 lines
  // and lands here as `run-judge.ts`, `read-evals.ts` and four domain modules —
  // so the production tree never approached the budget. It bit ONCE, in the
  // 400-line WARNING band rather than at the 500-line wall, and in a test
  // double:
  //
  //   application/testing/in-memory-eval-stores.ts, 401 effective. It held three
  //   repositories, and the third had no reason to be there: a criterion and an
  //   eval are coupled by `AgentEval.criterion @relation(onDelete: Cascade)`,
  //   which the double now models, and a golden set is coupled to neither. Split
  //   into `in-memory-eval-stores.ts` and
  //   `in-memory-golden-sets-repository.ts` along that seam rather than waived.
  //
  // One of the 83 files exists only because of that split, and `governance` adds
  // NO file to the warning list below. Its branch went on to say "every one of
  // the 478 is inside the budget and none is inside the warning band", which was
  // a claim about the whole census on the tree it measured and is NOT true of
  // this one — the four files named below are findings — so that sentence is
  // corrected here rather than carried, exactly as the channels and
  // observability branches' versions of it were.
  //
  // +8: WIN-256's `conversations` prerequisite adds four source files and four
  // suites under packages/contexts/providers for the ModelRouter inference
  // surface. The largest of the eight is well inside the warning band — the
  // message model, the cache placement, the generation vocabulary and the use
  // case were written as four files rather than one for exactly the reason ADR
  // M0.3 §6 names: a turn's orchestration split into named sub-use-case files is
  // what stops the next 7.1k-line service. Its branch pinned 336 (328 + 8) and
  // added "every one of the 328 is inside the budget and none is inside the
  // 400-line warning band" — the same whole-census claim the privacy, channels,
  // observability and governance branches each made, false of this tree for the
  // same reason, and corrected here rather than carried. The eight themselves
  // add NO file to the warning list below.
  //
  // Each branch pinned only the axis it could see: eventing pinned 307
  // (263 + 44), skills pinned 318 (263 + 55), and each pinned 372 and 383
  // respectively once rebased onto the providers tip; jobs pinned 379
  // (328 + 51) on v1, memory pinned 405 (328 + 77) and cost-monitoring pinned
  // 391 (328 + 63), privacy pinned 376 (328 + 48) and observability pinned 376
  // (328 + 48) as well, agents pinned 395 (328 + 67), tools pinned 384
  // (328 + 56) and channels pinned 370 (328 + 42). The governance branch alone
  // branched from the agents branch rather than from v1, so it could see agents'
  // +67 and pinned 478 (328 + 67 + 83) — a partial sum too, blind to the other
  // nine. The axes are disjoint, so the
  // integrated census is their SUM and not any branch pin:
  // 328 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 + 8 + 74 = 1044,
  // the last term being `conversations`, the seventeenth and final context: 78
  // real .ts files where 4 generated placeholders stood, so 78 - 4 = 74 and the
  // subtraction is written out rather than folded away.
  // Privacy and observability pinned the SAME 376 from the same base by
  // coincidence — both are 33 source + 15 test — which is precisely why the two
  // are summed rather than reconciled to the number they agree on.
  //
  // FOUR FILES ARE IN THE WARNING BAND, and this comment says so rather than
  // repeating the sentence that was true before `jobs`, `memory` and `tools`
  // landed:
  //
  //   packages/contexts/jobs/application/approval-lifecycle.test.ts   465
  //   packages/contexts/memory/application/authorization.test.ts      448
  //   packages/contexts/memory/contracts/index.test.ts                404
  //   packages/contexts/tools/application/tool-policy.test.ts         453
  //
  // All four are TEST modules, all four are below the 500-line hard error,
  // and the gate reports them as warnings by design. The assertions below pin
  // what the gate ENFORCES — zero errors — and deliberately do not pin zero
  // warnings, because the warning band exists to be visible rather than empty.
  // The jobs branch's own note claimed its largest file was "well inside the
  // 400-line warn threshold", and the memory and cost-monitoring branches each
  // said "none is inside the warning band"; running the audit over the
  // integrated tree shows none of those sentences was true of the tree it
  // describes, so all three claims are corrected here rather than carried.
  // cost-monitoring itself adds no file to this list — its own 412-line
  // alerting suite was split before adoption — but its blanket sentence was
  // still a claim about the whole census. The privacy branch said "every one of
  // the 328 is inside the budget and none is inside the 400-line warning band",
  // which was already false of the tree it was rebased onto; it is corrected
  // here rather than carried, and privacy itself adds no file to the list.
  //
  // The observability branch went further and said "`findings` is now EMPTY, not
  // merely free of errors: every one of the 376 clears the 400-line warning band
  // too". That is false of THIS tree for the same reason — the three files above
  // are findings — and it is corrected here rather than carried. What IS true,
  // and is what that branch actually earned, is that its own 453-line
  // drain-projections suite was split into
  // application/drain-projections.lanes.test.ts before adoption, so observability
  // adds no file to the list either. The list is unchanged at three.
  //
  // `agents` adds none either, and its branch is the one that did NOT claim
  // otherwise: two of its 25 files exist precisely because this budget bit in the
  // warning band and the answer was a split rather than a waiver.
  //
  // `tools` DOES add one, and it is named above rather than absorbed:
  // application/tool-policy.test.ts at 453 effective lines. The tools branch
  // said of its own last wave that "neither file is in the warning band", which
  // was a true sentence about the two files that wave touched and is not a
  // sentence about this census — tool-policy.test.ts reached the band in the
  // hosted-MCP gate wave before it, when fourteen cases were added to a suite
  // already at 10. It is inside the budget, below the 500-line hard error, and
  // it is a warning the gate is meant to show rather than one this pin should
  // hide. `channels` adds none: its largest file is 280 effective lines. The
  // list is four, and the four are named.
  //
  // WIN-256 MODEL ROUTER ADAPTER: THE SELECTOR ITSELF WIDENS, from two roots to
  // four, and this is the one delta on the list that changes what the gate
  // JUDGES rather than only what the tree CONTAINS. `packages/kernel/**` and
  // `packages/adapters/**` had never been covered: the rule was written for the
  // layer ADR M0.3 §6 is about and read as if it covered `packages/**`, and the
  // gap was the two roots that had held nothing but declaration placeholders.
  // The first real adapter arrived with a 645-effective-line end-to-end suite —
  // over the ERROR threshold, under no threshold at all — and the answer was
  // again a split rather than a waiver: it is now four suites divided by concern
  // (one step, the tool loop, schema-shaped output, streaming).
  //
  // `packages/**` itself is deliberately NOT the selector; the other eleven
  // directories under it are legacy packages this programme does not own.
  //
  // The integrated census is the sum of four disjoint scans:
  //
  //     packages/kernel/**                20   NEWLY COVERED
  //     packages/contexts/**            1060
  //     packages/adapters/**              88
  //     apps/core-api/src/transports/**    6
  //                                     ----
  //                                     1174
  //
  // `packages/contexts/**` is 1060: 964 at adoption, +4 because the adapter branch
  // adds two domain modules and two suites to `providers`, +18 for WIN-257, and
  // +74 for conversations (78 real .ts where 4 placeholders stood).
  // `packages/adapters/**`
  // is 66: the TEN still-unadopted adapters carry two declaration placeholders
  // each (20), model-router-providers carries 32 — seventeen source modules and
  // fifteen suites — and WIN-258's postgres-tenancy carries 14: eight source
  // modules (the client, the unit of work, the mapping, three repository
  // modules, the assembly and the entry point), two unit suites, the shared
  // conformance scenario, the container harness and two integration suites. The
  // eleventh placeholder pair became those 14, so the row moves 54 -> 66 and the
  // ADAPTERS census below moves 22 -> 20 in the same step. The adapter branch pinned
  // 20 + 334 + 54 + 6 = 414 against a v1-based tree that had none of the eleven
  // contexts; 414 is not the number here and its +4, +20 and +54 are the parts
  // that conserve.
  //
  // WIDENING THE SELECTOR ADDED NO VIOLATION. The 74 newly covered files (20 under
  // `packages/kernel/**` and 54 under `packages/adapters/**` -- not to be confused
  // with the +74 conversations contributes to `packages/contexts/**` below) produce
  // zero errors and zero warnings; the finding list below is unchanged at the
  // same four contexts files it already named. That is a measured result over
  // the integrated tree, not an inherited claim — and the selector is NOT to be
  // narrowed back if a later branch makes it bite, because biting is what it is
  // for.
  //
  // WIN-257 OPERATOR IDENTITY (M2.2) adds 18 files, 1048 -> 1066, all of them
  // under `packages/contexts/**`, which is why that row alone moves. Its own
  // branch pinned 328 -> 330 -> 334 -> 342 -> 346 against v1; 346 is not the
  // number here and the +18 is the part that conserves. Broken out:
  //
  //   +2  T1 adds identity-access-service.ts and its refusal suite. Both are
  //       well inside the budget; the facade holds no rule, only the
  //       projection, which is what keeps it small.
  //
  //   +4  T3 adds create-organization.ts, create-project.ts and a suite for
  //       each. Every gate in both use cases runs BEFORE the unit of work
  //       opens, which is what keeps the transactional block four lines long
  //       and both files inside the budget.
  //
  //   +8  T4 adds the four read-model files and their four suites. The two
  //       domain files are predicates and comparators with no I/O, and the two
  //       application files hold the composition the routes performed, so all
  //       eight sit well inside the budget.
  //
  //   +4  T5 adds domain/session-cookie.ts and its suite -- the whole contract
  //       is a shape, four guards and a mint, so it stays far inside the budget
  //       even carrying the RFC reasoning in prose -- plus the two suites THIS
  //       GATE forced out of identity-access-service.test.ts, which the facade's
  //       cookie cases took to 501 effective lines. As in the note above, the
  //       answer was to split along the seam the budget was pointing at rather
  //       than to raise the number: store-backed authentication on one side,
  //       the clock-and-transport cookie contract and the end-user read on the
  //       other.
  //
  // None of the 18 is inside the 400-line warning band, so the finding list
  // below is unchanged.
  //
  // WIN-258 POSTGRES-TENANCY (M2.3) adds 12 NET under `packages/adapters/**`:
  // 14 real files where the adapter's two declaration placeholders stood. Two of
  // the fourteen were forced by this gate and are worth naming, because both are
  // the split-rather-than-waive answer the notes above describe. The repository
  // is three modules (tree, membership, invitation) rather than one, which would
  // have been about 340 effective lines and inside the budget but not inside the
  // seam; and the integration suite is two files plus a harness, because it
  // reached 604 effective lines — over the 500 ERROR threshold — as one. Nothing
  // the adapter adds is inside the 400-line warning band; the largest is the
  // repository integration suite at 374, so the finding list below is unchanged.
  //
  // WIN-256 CONVERSATIONS, the seventeenth and last context, adds 74 more under
  // `packages/contexts/**` (78 real .ts files where 4 generated placeholders stood),
  // 1066 -> 1140. Its own branch pinned 1044 with a sum ending `+ 8 + 74`, blind to
  // the adapter's +4/+20/+54 and to WIN-257's +18; 1044 is not the number here. The
  // 7,121-line oracle service it brings is split below even the 400-line warning
  // band, so the finding list below is unchanged by it.
  //
  // WIN-258 TRANCHE 2 adds 22 more under `packages/adapters/**`, 1152 -> 1174,
  // and no subtraction: the directory was already adopted, so it has no
  // placeholders left to release. THIS GATE BIT TWICE while the tranche was
  // written, and both times the budget was pointing at a real seam rather than
  // at a number that wanted raising:
  //
  //   `identity-mapping.ts` reached 452 effective lines and was split into the
  //   REFUSALS (scope assembly and the five row-refusal codes) and the
  //   TRANSCRIPTION (`identity-rows.ts`: the structural row shapes and the pure
  //   row -> record mappers). 188 and 297.
  //
  //   `identity-differential.integration.test.ts` reached 537 — over the 500
  //   ERROR threshold — and was split into a shared harness plus two suites
  //   along the seam it already had: the session methods, and the login paths
  //   with MFA and impersonation. 273, 121 and 279.
  //
  // The conformance scenario was split for the same reason at 428, into the
  // person-keyed half and the tenant-scoped half. Nothing this tranche adds is
  // now inside the 400-line warning band, so the finding list below is unchanged.
  //
  // WIN-258 TRANCHE 3 adds 11 more under `packages/adapters/**`, 1174 -> 1185,
  // and no subtraction for the same reason. THIS GATE DID NOT BITE, and that is
  // worth stating rather than passing over: the largest file the tranche adds is
  // `locks.integration.test.ts` at 322 effective lines, well inside the 400-line
  // warning band, because the five ports were split by PORT rather than gathered
  // into one module and the suites by QUESTION -- whether the locks block, what
  // the two stores answer, what a wrong transaction scope does, what the
  // statements cost. The finding list below is therefore unchanged at the same
  // four contexts files it already named.
  //
  // WIN-258 TRANCHE 4 adds 15 more under `packages/adapters/**`, 1174 -> 1189,
  // across TWO directories: nine in `packages/adapters/outbox` (five source
  // modules and four suites, with no subtraction because adoption edits its two
  // placeholders in place) and six in `packages/adapters/postgres-tenancy` (the
  // store, its harness, and four real-PostgreSQL suites).
  //
  // THE BUDGET SHAPED THE SPLIT AGAIN, and again it was pointing at a real seam.
  // The outbox's four integration concerns are four files rather than one --
  // failure injection, migration-only constraints, statement counts and the
  // conformance replay -- because as one suite they would have been well over
  // the 500-line ERROR threshold, and because each has its own harness needs.
  // Nothing this tranche adds is inside the 400-line warning band; the largest
  // is `outbox-transaction.integration.test.ts` at 221, so the finding list
  // below is unchanged by it.
  //
  // MERGED, THE PIN IS THE SUM: 1174 + 11 + 15 = 1200. Each tranche pinned its
  // own addition against the same base and each was right alone; taking either
  // number here would have silently dropped the other's eleven or fifteen files
  // out of a gate whose whole job is to see every file. The gate still does not
  // bite: the largest file either tranche adds is `locks.integration.test.ts` at
  // 322 effective lines, and the finding list below is unchanged by both.
  // WIN-258 TRANCHE 5 adds 18 more under `packages/adapters/**`, 1200 -> 1218,
  // all of them in `packages/adapters/postgres-tenancy`: twelve source modules
  // and six suites. Its `.sql` fixture and its guard ledger are not source and
  // are not scanned here.
  //
  // THE BUDGET BIT THIS TIME, AND THE SPLIT IS THE ANSWER. The eight
  // tenant-isolation and transcript-integrity cases were first appended to
  // `tools-constraints.integration.test.ts`, which took it to 467 effective
  // lines -- inside the 400-line warning band and heading for the 500-line ERROR
  // threshold. They live in `tools-isolation.integration.test.ts` instead,
  // because the seam the budget was pointing at is real: that file is about
  // rules that exist ONLY IN THE MIGRATIONS, and this one is about what the
  // STORE decides. `tools-constraints.integration.test.ts` is back at 339
  // effective lines and the new file is 222, so the finding list below is
  // unchanged by this tranche too — nothing it adds reaches the warning band.
  //
  // WIN-258 TRANCHE 5 adds 16 more again, 1218 -> 1234,
  // all of them in `packages/adapters/postgres-tenancy`: the two stores split
  // across five modules, the row readers, the refusal parser, the harness, the
  // shared conformance scenario in two halves, and six suites.
  //
  // AND THIS TIME THE BUDGET DID BITE, twice, before either file was committed.
  // `AgentsRepository` has three scoping regimes -- project, environment and
  // version -- and one module holding all of them was past the 500-line ERROR
  // threshold, so it is `agents-catalog`, `agents-versions` and
  // `agents-clusters` behind one `createAgentsRepository`. The integration
  // suites split by QUESTION for the same reason the outbox's did: what the
  // migrations refuse, what a failed write costs, what the statements cost, and
  // whether the double and the database answer alike. The largest file the
  // tranche adds is `agents-conformance.ts` at 436 raw lines and well under the
  // effective threshold, so the finding list below is unchanged by it.
  //
  // THE TWO TRANCHE-5 BLOCKS SUM: 1200 + 18 + 16 = 1234. Both stores are in the
  // one adapter directory, so neither branch's own figure survives the merge.
  assert.equal(result.fileCount, 1234);
  // Written out so a DELETION CANNOT HIDE INSIDE AN ADDITION: adoption replaces
  // a context's four placeholders in place and adds the rest, so this number
  // only ever grows and a fall in it is always a finding.
  assert.equal(
    result.fileCount,
    328 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 + 8 + 4 + 20 + 54 + 18 + 74 + 12 + 22 + 11 + 9 + 6 + 18 + 16
  );
  // The adapters row of the four-way disjoint scan carries every tranche, and
  // tranche 5 contributes TWICE because it landed two canonical stores in the
  // one directory: 88 + 11 (tranche 3) + 15 (tranche 4) + 18 (tools) + 16
  // (agents) = 148. Only the adapters term moves, because neither store adds a
  // file to a context, to the kernel or to the REST transports — each
  // implements a port that already existed rather than widening one.
  assert.equal(result.fileCount, 20 + 1060 + 148 + 6);
  assert.deepEqual(result.errors, []);
  assert.equal(result.findings.filter((finding) => finding.severity === "error").length, 0);
  // Stricter than the gate, on purpose. `audit:max-file-lines` exits 0 on a
  // warning, so a file drifting into the 400-500 band is invisible to CI and
  // accumulates. The observability branch pinned `findings` EMPTY, and that is
  // what turned its 453-line drain-projections.test.ts into a split instead of a
  // shrug. EMPTY is false of the integrated tree — `jobs` and `memory` each
  // brought a warning-band suite with them — so the anti-drift property is kept
  // by pinning the EXACT list rather than by deleting the assertion or by
  // reformatting four real warnings out of existence. A FIFTH file drifting into
  // the band still turns this red, which is the whole point; the four below are
  // named, in the band, and below the 500-line hard error. `tools` is the fourth
  // and it arrived with this merge, so it is added here with its measured line
  // count rather than left to be discovered by a later branch.
  assert.deepEqual(result.findings, [
    {
      path: "packages/contexts/jobs/application/approval-lifecycle.test.ts",
      effectiveLines: 465,
      severity: "warning",
    },
    {
      path: "packages/contexts/memory/application/authorization.test.ts",
      effectiveLines: 448,
      severity: "warning",
    },
    {
      path: "packages/contexts/memory/contracts/index.test.ts",
      effectiveLines: 404,
      severity: "warning",
    },
    {
      path: "packages/contexts/tools/application/tool-policy.test.ts",
      effectiveLines: 453,
      severity: "warning",
    },
  ]);
});

test("selector drift to missing roots fails non-vacuity independently", () => {
  const result = auditMaxFileLines(repositoryRoot, { selectors: ["packages/not-a-context/**"] });
  assert.equal(result.fileCount, 0);
  assert.ok(result.errors.some((error) => error === "selector matched zero source files: packages/not-a-context/**"));
});

test("one valid selector cannot hide a second selector that matches nothing", () => {
  const result = auditMaxFileLines(repositoryRoot, {
    selectors: ["packages/contexts/**", "apps/core-api/src/not-a-transport/**"],
  });
  assert.ok(result.fileCount > 0);
  assert.deepEqual(result.errors, ["selector matched zero source files: apps/core-api/src/not-a-transport/**"]);
});

test("threshold inversion fails closed", () => {
  const root = fixture("packages/contexts/tools/application/one.ts", "export type One = 1;\n");
  const result = auditMaxFileLines(root, { warningThreshold: 500, errorThreshold: 400 });
  assert.ok(result.errors.some((error) => error.includes("must be lower")));
});
