// Bind the use cases into the driving port.
//
// The composition root builds the dependency bundle from adapters and calls this
// once. Nothing here holds state: it is a lookup table from a contract method to
// the one use case that implements it, which is what keeps the contract from
// quietly growing behaviour of its own. Every method here is exactly one call —
// if a line in this file does more than forward, that logic belongs in a use
// case where it can be tested without the whole bundle.
//
// THE TWO KERNEL PORTS ARE MINTED ONCE AND HANDED BACK BY IDENTITY. A composition
// root that received a fresh `ErasureTarget` on every call could inject two of
// them into `privacy` and count the same rows twice; a fresh `SafetyEventSink`
// per call would be a new object on every enforcement decision. Both are built
// when the contract is built, and `governance-contract.test.ts` pins the
// identity so a refactor to a factory-per-call is caught.

import type { ErasureTarget, SafetyEventSink } from "@platos/kernel";

import type { GovernanceContract } from "../contracts/index.js";
import type { GovernanceDependencies } from "./dependencies.js";
import { createGovernanceErasureTarget } from "./governance-erasure-target.js";
import { createGovernanceSafetyEventSink } from "./safety-event-sink.js";
import { recordSafetyEvent } from "./record-safety-event.js";
import { describeSafetyEvent, pageSafetyEvents, summariseSafety } from "./read-safety.js";
import { rateTurn, readTurnRating, withdrawRating } from "./rate-turn.js";
import { readAgentSatisfaction, readVersionSatisfaction } from "./read-ratings.js";
import {
  createCriterion,
  describeCriterion,
  pageCriteria,
  removeCriterion,
  updateCriterion,
} from "./criteria.js";
import { runJudge } from "./run-judge.js";
import { aggregateAgentEvals, describeEval, pageEvals } from "./read-evals.js";
import {
  createGoldenSet,
  describeGoldenSet,
  pageGoldenSets,
  removeGoldenSet,
  updateGoldenSet,
} from "./golden-sets.js";
import { enqueueEvalRun } from "./enqueue-eval-run.js";
import { reportRegression } from "./regression-report.js";
import { readRiskBoard } from "./risk-report.js";

export function createGovernanceContract(dependencies: GovernanceDependencies): GovernanceContract {
  const sink: SafetyEventSink = createGovernanceSafetyEventSink(dependencies);
  const erasure: ErasureTarget = createGovernanceErasureTarget(dependencies);

  const contract: GovernanceContract = {
    name: "governance",

    recordSafetyEvent: (command) => recordSafetyEvent(dependencies, command),
    pageSafetyEvents: (query) => pageSafetyEvents(dependencies, query),
    describeSafetyEvent: (query) => describeSafetyEvent(dependencies, query),
    summariseSafety: (query) => summariseSafety(dependencies, query),
    safetyEventSink: () => sink,

    rateTurn: (command) => rateTurn(dependencies, command),
    withdrawRating: (command) => withdrawRating(dependencies, command),
    readTurnRating: (query) => readTurnRating(dependencies, query),
    readVersionSatisfaction: (query) => readVersionSatisfaction(dependencies, query),
    readAgentSatisfaction: (query) => readAgentSatisfaction(dependencies, query),

    createCriterion: (command) => createCriterion(dependencies, command),
    updateCriterion: (command) => updateCriterion(dependencies, command),
    removeCriterion: (query) => removeCriterion(dependencies, query),
    describeCriterion: (query) => describeCriterion(dependencies, query),
    pageCriteria: (query) => pageCriteria(dependencies, query),

    runJudge: (command) => runJudge(dependencies, command),
    pageEvals: (query) => pageEvals(dependencies, query),
    describeEval: (query) => describeEval(dependencies, query),
    aggregateAgentEvals: (query) => aggregateAgentEvals(dependencies, query),

    createGoldenSet: (command) => createGoldenSet(dependencies, command),
    updateGoldenSet: (command) => updateGoldenSet(dependencies, command),
    removeGoldenSet: (query) => removeGoldenSet(dependencies, query),
    describeGoldenSet: (query) => describeGoldenSet(dependencies, query),
    pageGoldenSets: (query) => pageGoldenSets(dependencies, query),
    enqueueEvalRun: (command) => enqueueEvalRun(dependencies, command),
    reportRegression: (query) => reportRegression(dependencies, query),

    readRiskBoard: (query) => readRiskBoard(dependencies, query),

    erasureTarget: () => erasure,
  };
  return Object.freeze(contract);
}
