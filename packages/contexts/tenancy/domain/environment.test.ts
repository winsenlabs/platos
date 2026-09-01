import { describe, expect, it } from "vitest";

import { archivedAncestor } from "./ancestry.js";
import {
  archiveEnvironment,
  bumpAccessKeyRevocationVersion,
  isEnvironmentArchived,
  restoreEnvironment,
} from "./environment.js";
import { archiveOrganization, restoreOrganization } from "./organization.js";
import { archiveProject } from "./project.js";
import { anEnvironment, anOrganization, aProject } from "./record-builders.js";
import { endEnvironmentSession, isEnvironmentSessionOpen } from "./environment-session.js";
import { asIdentifier } from "@platos/kernel";
import type { EnvironmentSessionId, OperatorSessionId } from "./identifiers.js";
import { PrincipalTier } from "./roles.js";

const AT = new Date("2026-09-09T00:00:00.000Z");
const LATER = new Date("2026-10-10T00:00:00.000Z");

describe("archival", () => {
  it("is idempotent and keeps the first instant", () => {
    const environment = anEnvironment("prod", aProject("app", anOrganization("acme").id).id);
    const archived = archiveEnvironment(environment, AT);
    expect(isEnvironmentArchived(archived)).toBe(true);
    expect(archiveEnvironment(archived, LATER)).toBe(archived);
    expect(restoreEnvironment(archived, LATER).archivedAt).toBeNull();
  });

  // Archival propagates by EFFECT, never by rewriting descendant rows, so
  // restoring a parent cannot resurrect a child somebody archived deliberately.
  it("does not cascade a restore onto a separately archived descendant", () => {
    const organization = archiveOrganization(anOrganization("acme"), AT);
    const project = archiveProject(aProject("app", organization.id), AT);
    const environment = anEnvironment("prod", project.id);
    expect(archivedAncestor({ organization, project, environment })).toBe("organization");

    const restored = restoreOrganization(organization, LATER);
    // The project stays archived, so the environment is still denied.
    expect(archivedAncestor({ organization: restored, project, environment })).toBe("project");
  });
});

describe("the access-key revocation generation", () => {
  const environment = anEnvironment("prod", aProject("app", anOrganization("acme").id).id);

  it("starts at the schema default", () => {
    expect(environment.accessKeyRevocationVersion).toBe(0);
  });

  // Monotonic and unconditional: a revocation must always dominate a rotation
  // that read an older generation.
  it("only ever moves forward", () => {
    const once = bumpAccessKeyRevocationVersion(environment, AT);
    const twice = bumpAccessKeyRevocationVersion(once, LATER);
    expect(once.accessKeyRevocationVersion).toBe(1);
    expect(twice.accessKeyRevocationVersion).toBe(2);
    expect(twice.updatedAt).toEqual(LATER);
  });

  it("carries the two memory-owned columns untouched", () => {
    const bumped = bumpAccessKeyRevocationVersion(
      { ...environment, memoryFeedbackBackfillCursor: "cursor-1" },
      AT,
    );
    expect(bumped.memoryFeedbackBackfillCursor).toBe("cursor-1");
    expect(bumped.memoryFeedbackBackfillCompletedAt).toBeNull();
  });
});

describe("environment sessions", () => {
  // Modelled from the schema alone: this row has no production caller anywhere,
  // so there is no lifecycle to extract and none is invented.
  const session = {
    id: asIdentifier<EnvironmentSessionId>("es-1"),
    environmentId: anEnvironment("prod", aProject("app", anOrganization("acme").id).id).id,
    operatorSessionId: asIdentifier<OperatorSessionId>("os-1"),
    tier: PrincipalTier.OPERATOR,
    ipAddress: null,
    userAgent: null,
    lastSeenAt: null,
    endedAt: null,
    createdAt: AT,
  };

  it("ends once and stays ended", () => {
    expect(isEnvironmentSessionOpen(session)).toBe(true);
    const ended = endEnvironmentSession(session, AT);
    expect(isEnvironmentSessionOpen(ended)).toBe(false);
    expect(endEnvironmentSession(ended, LATER)).toBe(ended);
  });
});
