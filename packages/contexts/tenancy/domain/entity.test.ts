import { environmentScope, resolvePath } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { entityBelongsToProject, entityKey, markEntityConnected } from "./entity.js";
import { anEntity, anEnvironment, anOrganization, aProject, projectId } from "./record-builders.js";

const CONNECTED_AT = new Date("2026-07-07T00:00:00.000Z");

describe("Entity hangs off Project, not Environment", () => {
  const organization = anOrganization("acme");
  const project = aProject("app", organization.id);
  const staging = anEnvironment("staging", project.id);
  const production = anEnvironment("prod", project.id);
  const entity = anEntity("crm", project.id);

  // The charter says "org -> project -> environment -> entity". The schema
  // does not: `Entity.projectId` is the only parent link, and the natural key
  // is `@@unique([projectId, externalId])`. This test pins the schema.
  it("is keyed by project and external id, with no environment anywhere", () => {
    expect(entityKey(project.id, entity.externalId)).toBe("proj/app/entity/crm");
    expect(entityKey(project.id, entity.externalId)).not.toContain("env/");
  });

  it("is a sibling of every environment of its project, not a child of one", () => {
    expect(entityBelongsToProject(entity, project.id)).toBe(true);
    // The same entity is reachable from BOTH environments of the project.
    for (const environment of [staging, production]) {
      const scope = environmentScope(organization.id, project.id, environment.id);
      expect(resolvePath(scope).startsWith(`org/acme/proj/${project.id}`)).toBe(true);
      // ...and its key is identical whichever environment you came in through.
      expect(entityKey(environment.projectId, entity.externalId)).toBe(
        entityKey(project.id, entity.externalId),
      );
    }
  });

  it("does not belong to another project even with the same external id", () => {
    const rivalProject = projectId("rival-app");
    expect(entityBelongsToProject(entity, rivalProject)).toBe(false);
    expect(entityKey(rivalProject, entity.externalId)).not.toBe(
      entityKey(project.id, entity.externalId),
    );
  });

  it("records a connection without moving its parent", () => {
    const connected = markEntityConnected(entity, CONNECTED_AT);
    expect(connected.lastConnectedAt).toEqual(CONNECTED_AT);
    expect(connected.projectId).toBe(entity.projectId);
  });
});
