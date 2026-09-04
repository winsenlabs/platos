import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ActorId, AgentId, EvalCriterionId } from "../domain/index.js";
import {
  createCriterion,
  describeCriterion,
  pageCriteria,
  removeCriterion,
  updateCriterion,
} from "./criteria.js";
import {
  AGENT_ID,
  aCriterionDraft,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const AUTHOR = asIdentifier<ActorId>("operator-1");
let context: GovernanceTestContext;

beforeEach(() => {
  context = buildGovernanceTestContext();
});

async function create(overrides: Record<string, unknown> = {}) {
  return createCriterion(context.dependencies, {
    authorization: context.authorization,
    createdBy: AUTHOR,
    criterion: { ...aCriterionDraft(), ...overrides } as never,
  });
}

describe("createCriterion", () => {
  it("writes into the granted environment and records the author", async () => {
    const written = await create();
    expect(written.ok && written.value.environmentId).toBe("env-1");
    expect(written.ok && written.value.createdBy).toBe(AUTHOR);
    expect(written.ok && written.value.isActive).toBe(true);
  });

  it("REFUSES an unminted grant and WRITES NOTHING", async () => {
    const written = await createCriterion(context.dependencies, {
      authorization: {},
      createdBy: AUTHOR,
      criterion: aCriterionDraft() as never,
    });
    expect(written.ok).toBe(false);
    expect(context.criteria.size()).toBe(0);
  });

  it("REFUSES a blank name before touching the store", async () => {
    const written = await create({ name: "  " });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_CRITERION_NAME_INVALID");
    expect(context.criteria.size()).toBe(0);
  });

  it("REFUSES an unusable score scale, with its own code", async () => {
    const written = await create({ scoreScaleMin: 10, scoreScaleMax: 10 });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_CRITERION_SCALE_INVALID");
    expect(context.criteria.size()).toBe(0);
  });

  it("REFUSES a duplicate name in the SAME environment", async () => {
    await create({ name: "grounded" });
    const second = await create({ name: "grounded" });
    expect(!second.ok && second.error.code).toBe("GOVERNANCE_CRITERION_ALREADY_EXISTS");
    expect(context.criteria.size()).toBe(1);
  });

  it("refuses the duplicate BEFORE opening a transaction", async () => {
    // The store holds the constraint too, so "was it refused?" cannot tell the
    // pre-check apart from the store. What can is WHERE it was refused: with the
    // pre-check nothing reaches a transaction, and a lost pre-check would show
    // up here as a second unit of work opened and rolled back.
    await create({ name: "grounded" });
    expect(context.unitOfWork.opened).toBe(1);
    const second = await create({ name: "grounded" });
    expect(second.ok).toBe(false);
    expect(context.unitOfWork.opened).toBe(1);
  });

  it("allows the same name in a DIFFERENT environment — the constraint is per environment", async () => {
    await create({ name: "grounded" });
    const elsewhere = await createCriterion(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      createdBy: AUTHOR,
      criterion: aCriterionDraft({ name: "grounded" }) as never,
    });
    expect(elsewhere.ok).toBe(true);
  });

  it("is REFUSED BY THE STORE even if the pre-check is bypassed", async () => {
    // The pre-check is a better error message, not the guarantee: the store
    // holds the constraint, so a lost race still cannot write a duplicate.
    await create({ name: "grounded" });
    const direct = await context.dependencies.unitOfWork.run((transaction) =>
      context.criteria.create(
        context.scope,
        {
          agentId: null,
          name: "grounded",
          description: null,
          judgePrompt: "score it",
          rubric: null,
          judgeModel: null,
          scoreScaleMin: 0,
          scoreScaleMax: 100,
        },
        AUTHOR,
        transaction,
      ),
    );
    expect(!direct.ok && direct.error.code).toBe("GOVERNANCE_CRITERION_ALREADY_EXISTS");
  });

  it("writes inside one transaction that commits", async () => {
    await create();
    expect(context.unitOfWork.opened).toBe(1);
    expect(context.unitOfWork.lastOutcome).toBe("committed");
  });
});

describe("updateCriterion", () => {
  async function seeded() {
    const written = await create();
    if (!written.ok) throw new Error("unreachable");
    return written.value;
  }

  it("REFUSES a criterion in another environment as NOT FOUND", async () => {
    const criterion = await seeded();
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      criterionId: criterion.evalCriterionId,
      patch: { name: "renamed" },
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_NOT_FOUND");
  });

  it("REFUSES an id that does not exist", async () => {
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: asIdentifier<EvalCriterionId>("criterion-nope"),
      patch: {},
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_NOT_FOUND");
  });

  it("REFUSES a half-patched scale rather than storing an unscoreable criterion", async () => {
    const criterion = await seeded();
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { scoreScaleMin: 500 },
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_SCALE_INVALID");
    const stored = await describeCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
    });
    expect(stored.ok && stored.value.scoreScaleMin).toBe(0);
  });

  it("REFUSES a rename onto another criterion's name", async () => {
    await create({ name: "grounded" });
    const second = await create({ name: "tone" });
    if (!second.ok) throw new Error("unreachable");
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: second.value.evalCriterionId,
      patch: { name: "grounded" },
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_CRITERION_ALREADY_EXISTS");
  });

  it("ALLOWS a rename to the name it already has", async () => {
    const criterion = await seeded();
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { name: criterion.name },
    });
    expect(patched.ok).toBe(true);
  });

  it("stamps the clock's instant", async () => {
    const criterion = await seeded();
    context.clock.advanceMilliseconds(60_000);
    const patched = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { description: "now with a description" },
    });
    expect(patched.ok && patched.value.updatedAt.getTime()).toBe(context.clock.now().getTime());
    expect(patched.ok && patched.value.createdAt.getTime()).toBe(criterion.createdAt.getTime());
  });

  it("deactivates and reactivates", async () => {
    const criterion = await seeded();
    const off = await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: criterion.evalCriterionId,
      patch: { isActive: false },
    });
    expect(off.ok && off.value.isActive).toBe(false);
  });
});

describe("removeCriterion and describeCriterion", () => {
  it("removes one and answers true", async () => {
    const written = await create();
    if (!written.ok) throw new Error("unreachable");
    const removed = await removeCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId: written.value.evalCriterionId,
    });
    expect(removed).toEqual({ ok: true, value: true });
    expect(context.criteria.size()).toBe(0);
  });

  it("cannot remove a criterion in another environment, and leaves it there", async () => {
    const written = await create();
    if (!written.ok) throw new Error("unreachable");
    const removed = await removeCriterion(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      criterionId: written.value.evalCriterionId,
    });
    expect(removed).toEqual({ ok: true, value: false });
    expect(context.criteria.size()).toBe(1);
  });

  it("REFUSES a describe in another environment as NOT FOUND, never the row", async () => {
    const written = await create();
    if (!written.ok) throw new Error("unreachable");
    const found = await describeCriterion(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      criterionId: written.value.evalCriterionId,
    });
    expect(!found.ok && found.error.code).toBe("GOVERNANCE_CRITERION_NOT_FOUND");
  });
});

describe("pageCriteria — the active-only filter", () => {
  it("HIDES a deactivated criterion when `activeOnly` is asked for", async () => {
    await create({ name: "live" });
    const off = await create({ name: "retired" });
    const criterionId = off.ok ? off.value.evalCriterionId : ("" as EvalCriterionId);
    await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId,
      patch: { isActive: false },
    });

    const filtered = await pageCriteria(context.dependencies, {
      authorization: context.authorization,
      activeOnly: true,
    });
    expect(filtered.ok && filtered.value.total).toBe(1);
    expect(filtered.ok && filtered.value.items[0]?.name).toBe("live");
  });

  it("SHOWS it when `activeOnly` is not asked for, so the filter test is not vacuous", async () => {
    await create({ name: "live" });
    const off = await create({ name: "retired" });
    const criterionId = off.ok ? off.value.evalCriterionId : ("" as EvalCriterionId);
    await updateCriterion(context.dependencies, {
      authorization: context.authorization,
      criterionId,
      patch: { isActive: false },
    });
    const all = await pageCriteria(context.dependencies, { authorization: context.authorization });
    expect(all.ok && all.value.total).toBe(2);
  });
});

describe("pageCriteria", () => {
  it("clamps an over-wide page to EXACTLY the ceiling", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ criteria: { maxPageSize: 2 } }) });
    for (const name of ["a", "b", "c", "d"]) await create({ name });
    const page = await pageCriteria(context.dependencies, {
      authorization: context.authorization,
      limit: 100,
    });
    expect(page.ok && page.value.items).toHaveLength(2);
    expect(page.ok && page.value.limit).toBe(2);
    expect(page.ok && page.value.total).toBe(4);
  });

  it("REFUSES a negative offset", async () => {
    const page = await pageCriteria(context.dependencies, {
      authorization: context.authorization,
      offset: -1,
    });
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_PAGE_REQUEST_INVALID");
  });

  it("shows a SHARED criterion under an agent filter, alongside that agent's own", async () => {
    await create({ name: "shared", agentId: null });
    await create({ name: "specific", agentId: AGENT_ID });
    await create({ name: "elsewhere", agentId: asIdentifier<AgentId>("agent-2") });
    const page = await pageCriteria(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(page.ok && page.value.items.map((row) => row.name).sort()).toEqual(["shared", "specific"]);
  });

  it("shows ONLY shared criteria when the filter is an explicit null", async () => {
    await create({ name: "shared", agentId: null });
    await create({ name: "specific", agentId: AGENT_ID });
    const page = await pageCriteria(context.dependencies, {
      authorization: context.authorization,
      agentId: null,
    });
    expect(page.ok && page.value.items.map((row) => row.name)).toEqual(["shared"]);
  });

  it("does not filter at all when no agent key is present", async () => {
    await create({ name: "shared", agentId: null });
    await create({ name: "specific", agentId: AGENT_ID });
    const page = await pageCriteria(context.dependencies, { authorization: context.authorization });
    expect(page.ok && page.value.total).toBe(2);
  });

  it("does not show another environment's criteria", async () => {
    await create();
    const page = await pageCriteria(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(page.ok && page.value.total).toBe(0);
  });
});
