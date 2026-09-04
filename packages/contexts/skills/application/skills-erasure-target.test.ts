import {
  asIdentifier,
  organizationScope,
  type ErasureSubject,
  type TransactionId,
} from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { parseSkillSource } from "../domain/index.js";
import { registerOfficialSkill } from "./register-skill.js";
import {
  createSkillsErasureTarget,
  isSkillsErasurePlan,
  selectorFor,
  selectorIsVacuous,
  SKILL_MODEL,
  SKILLS_ERASURE_TARGET_NAME,
  SkillsErasureRejected,
} from "./skills-erasure-target.js";
import {
  ANONYMIZED_AUTHOR,
  buildSkillsTestContext,
  skillSource,
  type SkillsTestContext,
} from "./testing/index.js";

const ORG = organizationScope(asIdentifier("org-1"));
const TRANSACTION = { transactionId: asIdentifier<TransactionId>("txn-x") };

function subject(kind: ErasureSubject["subjectKind"], id = "author-1"): ErasureSubject {
  return { subjectKind: kind, subjectId: id, scope: ORG };
}

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function seedAuthored(context: SkillsTestContext, id: string, author: string): Promise<void> {
  const seeded = await registerOfficialSkill(context.dependencies, {
    organization: ORG,
    parsed: parsed(skillSource({ id, author })),
  });
  if (!seeded.ok) throw new Error(seeded.error.code);
}

describe("selectorFor", () => {
  it("selects on the principal for an operator subject", () => {
    expect(selectorFor(subject("user"))).toEqual({ scope: ORG, principalId: "author-1" });
  });

  it("selects NOTHING for an end user — an end user does not author a skill", () => {
    expect(selectorIsVacuous(selectorFor(subject("end-user")))).toBe(true);
  });

  it("selects NOTHING for an entity, which is not a person", () => {
    expect(selectorIsVacuous(selectorFor(subject("entity")))).toBe(true);
  });
});

describe("skills erasure target", () => {
  let context: SkillsTestContext;

  beforeEach(() => {
    context = buildSkillsTestContext();
  });

  it("names itself, so a plan says who is destroying what", () => {
    expect(createSkillsErasureTarget(context.dependencies).targetName).toBe(SKILLS_ERASURE_TARGET_NAME);
  });

  it("plans ANONYMIZE for Skill, not delete", async () => {
    // A skill row is a tool the organization runs, not the subject's data.
    // Deleting it would break other people's agents because the uploader
    // exercised a right to erasure.
    await seedAuthored(context, "a.b", "author-1");
    const plan = await createSkillsErasureTarget(context.dependencies).plan(subject("user"));
    expect(plan.items).toEqual([
      { model: SKILL_MODEL, method: "anonymize", rowCount: 1, blockedBy: null },
    ]);
  });

  it("does NOT list the install rows, which carry no subject column", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const plan = await createSkillsErasureTarget(context.dependencies).plan(subject("user"));
    expect(plan.items.map((item) => item.model)).toEqual([SKILL_MODEL]);
  });

  it("reports a ZERO-row plan rather than being silent for a subject it holds nothing for", async () => {
    const plan = await createSkillsErasureTarget(context.dependencies).plan(subject("entity"));
    expect(plan.items).toEqual([
      { model: SKILL_MODEL, method: "anonymize", rowCount: 0, blockedBy: null },
    ]);
  });

  it("leaves blockedBy null — holds are privacy's to adjudicate", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const plan = await createSkillsErasureTarget(context.dependencies).plan(subject("user"));
    expect(plan.items[0]?.blockedBy).toBeNull();
  });

  it("counts only the subject's own rows", async () => {
    await seedAuthored(context, "a.mine", "author-1");
    await seedAuthored(context, "b.theirs", "author-2");
    const plan = await createSkillsErasureTarget(context.dependencies).plan(subject("user"));
    expect(plan.items[0]?.rowCount).toBe(1);
  });

  it("overwrites the author on the row AND inside the stored manifest", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const target = createSkillsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    await target.erase(plan, TRANSACTION);

    const entry = context.repository.allSkills()[0];
    expect(entry?.author).toBe(ANONYMIZED_AUTHOR);
    // The manifest carries the author too; overwriting only the column would
    // leave the name legible in the stored JSON.
    expect(entry?.manifest.author).toBe(ANONYMIZED_AUTHOR);
  });

  it("KEEPS the skill usable after erasure — the capability survives its author", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const target = createSkillsErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject("user")), TRANSACTION);

    const entry = context.repository.allSkills()[0];
    expect(entry?.source).not.toBe("");
    expect(entry?.promptBlock).not.toBe("");
    expect(context.repository.allSkills()).toHaveLength(1);
  });

  it("does not touch another author's rows", async () => {
    await seedAuthored(context, "a.mine", "author-1");
    await seedAuthored(context, "b.theirs", "author-2");
    const target = createSkillsErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject("user")), TRANSACTION);

    const theirs = context.repository.allSkills().find((row) => row.identity.slug === "b.theirs");
    expect(theirs?.author).toBe("author-2");
  });

  it("REFUSES a plan it did not mint, rather than guessing a subject", async () => {
    const target = createSkillsErasureTarget(context.dependencies);
    await expect(
      target.erase({ targetName: "files", items: [] }, TRANSACTION),
    ).rejects.toBeInstanceOf(SkillsErasureRejected);
  });

  it("REFUSES a plan carrying this target's name but no subject rider", async () => {
    const target = createSkillsErasureTarget(context.dependencies);
    await expect(
      target.erase({ targetName: SKILLS_ERASURE_TARGET_NAME, items: [] }, TRANSACTION),
    ).rejects.toThrow(/SKILLS_ERASURE_PLAN_FOREIGN/u);
  });

  it("recognises its own plan and no other", async () => {
    const target = createSkillsErasureTarget(context.dependencies);
    expect(isSkillsErasurePlan(await target.plan(subject("user")))).toBe(true);
    expect(isSkillsErasurePlan({ targetName: "files", items: [] })).toBe(false);
  });

  it("REJECTS rather than issuing a receipt when the store fails mid-erasure", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const target = createSkillsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    context.repository.failNext("connection reset");
    // A receipt claiming rows were anonymised when they were not is worse than
    // a rejection, and rejecting rolls the caller's transaction back.
    await expect(target.erase(plan, TRANSACTION)).rejects.toBeInstanceOf(SkillsErasureRejected);
  });

  it("stamps the receipt from the clock port, not the wall clock", async () => {
    await seedAuthored(context, "a.b", "author-1");
    context.clock.set(new Date("2026-06-01T12:00:00.000Z"));
    const target = createSkillsErasureTarget(context.dependencies);
    const receipt = await target.erase(await target.plan(subject("user")), TRANSACTION);
    expect(receipt.erasedAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("reports what was ACTUALLY changed, which may differ from the plan", async () => {
    await seedAuthored(context, "a.b", "author-1");
    const target = createSkillsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user"));
    expect(plan.items[0]?.rowCount).toBe(1);

    // Erase once, then replay the same plan: nothing is left to change.
    await target.erase(plan, TRANSACTION);
    const replay = await target.erase(plan, TRANSACTION);
    expect(replay.items[0]?.rowCount).toBe(0);
  });
});
