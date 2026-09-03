import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type MacroId } from "../domain/index.js";
import {
  appendRecordingStep,
  describeMacro,
  listMacros,
  removeMacro,
  resolveMacro,
  startRecording,
  stopRecording,
  updateMacro,
} from "./macros.js";
import { buildAgentsTestContext, testEnvironmentScope, testMacro } from "./testing/fixtures.js";

const OWNER = "operator-1";
const STRANGER = "operator-2";

function newContext() {
  const context = buildAgentsTestContext();
  return { context, authorization: context.tenancy.grant() };
}

describe("the visibility gate", () => {
  it("shows an owner their own macro", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const described = await describeMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.access).toBe("owner");
  });

  it("hides an unshared macro from a stranger", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const described = await describeMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
    });
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("AGENTS_MACRO_NOT_FOUND");
  });

  it("shows a shared macro to a stranger, marked shared", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope, { sharedWithOrganization: true }));
    const described = await describeMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.access).toBe("shared");
  });

  it("hides a macro in another environment even from its own author", async () => {
    const { context, authorization } = newContext();
    context.scaffolding.seedMacro(testMacro(testEnvironmentScope("env-9")));
    const described = await describeMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: asAgentsIdentifier<MacroId>("macro-1"),
    });
    expect(described.ok).toBe(false);
  });

  it("RE-APPLIES the gate to every listed row, not just to the query", async () => {
    const { context, authorization } = newContext();
    context.scaffolding.seedMacro(testMacro(context.scope));
    context.scaffolding.seedMacro(
      testMacro(context.scope, { macroId: asAgentsIdentifier<MacroId>("macro-2"), sharedWithOrganization: true }),
    );
    const listed = await listMacros(context.dependencies, { authorization, actorId: STRANGER });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((entry) => entry.macro.macroId)).toEqual(["macro-2"]);
  });

  it("shows an unattributed caller only the shared macros", async () => {
    const { context, authorization } = newContext();
    context.scaffolding.seedMacro(testMacro(context.scope));
    const listed = await listMacros(context.dependencies, { authorization, actorId: null });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });

  it("clamps the listing size", async () => {
    const { context, authorization } = newContext();
    for (let index = 0; index < 3; index += 1) {
      context.scaffolding.seedMacro(
        testMacro(context.scope, { macroId: asAgentsIdentifier<MacroId>(`macro-${index}`) }),
      );
    }
    const listed = await listMacros(context.dependencies, { authorization, actorId: OWNER, limit: 1 });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
  });
});

describe("the mutation gate keeps its two answers", () => {
  it("lets the owner rename", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const patched = await updateMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
      name: "Renamed",
    });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.name).toBe("Renamed");
  });

  it("answers NOT FOUND for an invisible macro", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const patched = await updateMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
      name: "Renamed",
    });
    if (patched.ok) throw new Error("unreachable");
    expect(patched.error.code).toBe("AGENTS_MACRO_NOT_FOUND");
  });

  it("answers NOT EDITABLE for a macro the caller can legitimately SEE", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope, { sharedWithOrganization: true }));
    const patched = await updateMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
      name: "Renamed",
    });
    if (patched.ok) throw new Error("unreachable");
    expect(patched.error.code).toBe("AGENTS_MACRO_NOT_EDITABLE");
  });

  it("shares and un-shares through the same patch", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const shared = await updateMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
      sharedWithOrganization: true,
    });
    if (!shared.ok) throw new Error("unreachable");
    expect(shared.value.sharedWithOrganization).toBe(true);
  });
});

describe("deleting a macro", () => {
  it("removes the owner's own macro", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const removed = await removeMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(true);
    expect(context.scaffolding.macros.size).toBe(0);
  });

  it("ANSWERS FALSE rather than refusing for a macro the caller cannot see", async () => {
    // An idempotent delete must not become an existence oracle.
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const removed = await removeMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(false);
    expect(context.scaffolding.macros.size).toBe(1);
  });

  it("REFUSES a shared macro the caller can see but does not own", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope, { sharedWithOrganization: true }));
    const removed = await removeMacro(context.dependencies, {
      authorization,
      actorId: STRANGER,
      macroId: seeded.macroId,
    });
    if (removed.ok) throw new Error("unreachable");
    expect(removed.error.code).toBe("AGENTS_MACRO_NOT_EDITABLE");
  });

  it("answers false for a macro that never existed", async () => {
    const { context, authorization } = newContext();
    const removed = await removeMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: asAgentsIdentifier<MacroId>("nope"),
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(false);
  });
});

describe("resolving a macro for replay", () => {
  it("substitutes the parameters and RETURNS the steps rather than running them", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(context.scaffolding.seedMacro(testMacro(context.scope)));
    const resolved = await resolveMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
      params: { user: { email: "x@y" } },
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toEqual([{ tool: "mail.send", params: { to: "x@y" } }]);
  });

  it("leaves a missing placeholder in place", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    const resolved = await resolveMacro(context.dependencies, {
      authorization,
      actorId: OWNER,
      macroId: seeded.macroId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value[0]?.params).toEqual({ to: "${user.email}" });
  });

  it("applies the visibility gate before it resolves anything", async () => {
    const { context, authorization } = newContext();
    const seeded = context.scaffolding.seedMacro(testMacro(context.scope));
    expect(
      (
        await resolveMacro(context.dependencies, {
          authorization,
          actorId: STRANGER,
          macroId: seeded.macroId,
        })
      ).ok,
    ).toBe(false);
  });
});

describe("recording", () => {
  it("starts, appends and finalises into a macro owned by the recorder", async () => {
    const { context, authorization } = newContext();
    const started = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
    });
    if (!started.ok) throw new Error("unreachable");
    await appendRecordingStep(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
      step: { tool: "mail.send", params: { to: "${user.email}" } },
    });
    const stopped = await stopRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
      recordingId: started.value.recordingId,
      name: "  Digest  ",
    });
    if (!stopped.ok) throw new Error("unreachable");
    expect(stopped.value.name).toBe("Digest");
    expect(stopped.value.steps).toHaveLength(1);
    expect(stopped.value.createdBy).toBe(OWNER);
    expect(stopped.value.sharedWithOrganization).toBe(false);
  });

  it("is IDEMPOTENT on start: a second start returns the live recording", async () => {
    const { context, authorization } = newContext();
    const first = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
    });
    const second = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
    });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.recordingId).toBe(first.value.recordingId);
  });

  it("refuses to finalise a recording id this caller is not filling", async () => {
    const { context, authorization } = newContext();
    await startRecording(context.dependencies, { authorization, actorId: OWNER, sessionId: "session-1" });
    const stopped = await stopRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
      recordingId: "rec-stale",
      name: "Digest",
    });
    if (stopped.ok) throw new Error("unreachable");
    expect(stopped.error.code).toBe("AGENTS_MACRO_RECORDING_UNKNOWN");
  });

  it("refuses to finalise when there is no recording at all", async () => {
    const { context, authorization } = newContext();
    expect(
      (
        await stopRecording(context.dependencies, {
          authorization,
          actorId: OWNER,
          sessionId: "session-1",
          recordingId: "rec-1",
          name: "Digest",
        })
      ).ok,
    ).toBe(false);
  });

  it("refuses to start for an UNATTRIBUTED caller, who could not own the result", async () => {
    const { context, authorization } = newContext();
    expect(
      (await startRecording(context.dependencies, { authorization, actorId: null, sessionId: "s" })).ok,
    ).toBe(false);
  });

  it("appends nothing when the caller is not recording, without failing", async () => {
    const { context, authorization } = newContext();
    const appended = await appendRecordingStep(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
      step: { tool: "mail.send", params: {} },
    });
    expect(appended.ok).toBe(true);
  });

  it("refuses a name the macro policy will not admit, after finalising", async () => {
    const { context, authorization } = newContext();
    const started = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
    });
    if (!started.ok) throw new Error("unreachable");
    const stopped = await stopRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
      recordingId: started.value.recordingId,
      name: "   ",
    });
    if (stopped.ok) throw new Error("unreachable");
    expect(stopped.error.code).toBe("AGENTS_MACRO_INVALID");
  });

  it("keeps two sessions' recordings apart", async () => {
    const { context, authorization } = newContext();
    const first = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-1",
    });
    const second = await startRecording(context.dependencies, {
      authorization,
      actorId: OWNER,
      sessionId: "session-2",
    });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.recordingId).not.toBe(first.value.recordingId);
  });
});
