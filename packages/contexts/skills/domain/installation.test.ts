import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { SkillId } from "./identifiers.js";
import {
  EMPTY_SKILL_CONFIG,
  isInstallationEnabled,
  isUsable,
  mayEdit,
  mayUninstall,
  shouldMaterialiseInstall,
  type Installation,
} from "./installation.js";

function installation(project: boolean, environment: boolean): Installation {
  return {
    project: {
      projectSkillId: asIdentifier("ps-1"),
      scope: { level: "project", organizationId: asIdentifier("org-1"), projectId: asIdentifier("proj-1") },
      skillId: asIdentifier<SkillId>("skill-1"),
      enabled: project,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    environment: {
      environmentSkillId: asIdentifier("es-1"),
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
      projectSkillId: asIdentifier("ps-1"),
      enabled: environment,
      config: EMPTY_SKILL_CONFIG,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}

describe("EMPTY_SKILL_CONFIG", () => {
  it("is an empty object rather than null, matching the column default", () => {
    expect(EMPTY_SKILL_CONFIG).toEqual({});
  });

  it("is frozen, so one binding's default cannot be mutated into another's", () => {
    expect(Object.isFrozen(EMPTY_SKILL_CONFIG)).toBe(true);
  });
});

describe("isInstallationEnabled", () => {
  it("needs BOTH halves enabled", () => {
    expect(isInstallationEnabled(installation(true, true))).toBe(true);
  });

  it("is false when the project half is switched off", () => {
    // A project-level disable takes the skill out of every environment at once,
    // which is what a project-level switch is for.
    expect(isInstallationEnabled(installation(false, true))).toBe(false);
  });

  it("is false when the environment half is switched off", () => {
    expect(isInstallationEnabled(installation(true, false))).toBe(false);
  });
});

describe("isUsable", () => {
  it("makes an official skill usable with NO install", () => {
    expect(isUsable(true, null)).toBe(true);
  });

  it("makes a non-official skill with no install unusable", () => {
    expect(isUsable(false, null)).toBe(false);
  });

  it("defers to the install's flags once there is one, official or not", () => {
    expect(isUsable(true, installation(true, false))).toBe(false);
    expect(isUsable(false, installation(true, true))).toBe(true);
  });
});

describe("shouldMaterialiseInstall", () => {
  it("materialises for an official skill, which carries no install until bound", () => {
    expect(shouldMaterialiseInstall(true)).toBe(true);
  });

  it("never materialises for a non-official skill", () => {
    // A non-official skill can only be bound if it is already installed —
    // being installed is what made it visible. The read path cannot materialise
    // at all: it does not call this.
    expect(shouldMaterialiseInstall(false)).toBe(false);
  });
});

describe("mayUninstall", () => {
  it("permits uninstalling a tenant-owned skill", () => {
    expect(mayUninstall(false)).toBe(true);
  });

  it("REFUSES to uninstall an official skill", () => {
    expect(mayUninstall(true)).toBe(false);
  });
});

describe("mayEdit", () => {
  it("permits editing either kind — transcribed live behaviour, reported as a finding", () => {
    // The live `updateSkill` gates only on visibility, which includes every
    // official row, while `remove` gates on `isOfficial: false`. The asymmetry
    // is preserved because WIN-256 is a refactor. See the function's comment.
    expect(mayEdit(false)).toBe(true);
    expect(mayEdit(true)).toBe(true);
  });
});
