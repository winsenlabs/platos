// Use case: record what a connected entity says about its own tools.
//
// THIS USE CASE EXISTS BECAUSE THE `ToolHealth` UPSERT ON THE `/tools/sync`
// SOCKET HAD NO PUBLISHED FORM. `docs/audits/win-269-tool-lifecycle-reach.json`
// records `apps/agent/src/tool-gateway/tool-sync-ws.service.ts` as
// `waitingOn: "contract-method"` and states the gap in one line: the socket's
// registration half is already `registerTools`, and what is NOT published is
// "the socket's own lifecycle" — `Entity.connectionStatus`, which is tenancy's
// and now has `recordEntityConnection`, and "the `ToolHealth` upsert", which is
// this context's and is this file. Its site is the `blockedOnContract` row at
// `tool-sync-ws.service.ts:640`.
//
// THE SEMANTICS ARE THE ORACLE'S HEARTBEAT HANDLER, COPIED.
//
//   The frame is `{ type: "heartbeat", tools_health: { [name]: { status,
//   avg_latency_ms, error_count_1h, last_error? } } }`, typed identically by
//   `packages/platools-js/src/transport/protocol.ts` and
//   `packages/platools-py/platools/transport/protocol.py`.
//
//   For each named tool the handler looks the name up in the SCOPED tool set for
//   this entity, and upserts `ToolHealth` on
//   `(environmentId, toolId, entityExternalId)` with
//   `update: { lastStatus, avgLatencyMs }` and
//   `create: { ..., failCount: 0, totalCalls: 0 }`.
//
//   A NAME THE SCOPE DOES NOT EXPOSE IS SKIPPED, not refused: `scopedTools.find`
//   returns undefined and the `if (entry)` guard falls through. That is kept,
//   because it is the behaviour a reconnecting entity depends on — an SDK that
//   heartbeats a tool it has registered in a DIFFERENT environment, or one it
//   registered a moment ago in a frame this process has not committed yet, must
//   not have its whole heartbeat refused. The skipped names are RETURNED rather
//   than swallowed, so a transport can say so and an operator can see it, which
//   is the half the oracle has no way to express.
//
// WHAT IS NOT COPIED, AND IT IS ONE THING. The oracle wraps each upsert in
// `.catch(() => {})` and an outer `try {} catch {}` — "best-effort — don't break
// heartbeat". A published contract method may not swallow a store failure: the
// caller is holding a `Result` precisely so it can be told. So a repository
// refusal is returned, and the transport decides what a failed heartbeat means.
// The skip above is a BUSINESS rule about unknown names; the catch was a
// tolerance for a broken database, and those are not the same tolerance.
//
// ONE UNIT OF WORK FOR THE WHOLE FRAME. The oracle writes each row on its own,
// which is what "best-effort" costs: a heartbeat naming four tools could leave
// two rows advanced and two not, and nothing records which. A heartbeat is one
// statement by one entity at one instant, so it lands whole or not at all.
//
// THE ALERT FAN-OUT IS NOT HERE. The oracle also sends a `tool_health_alert`
// frame back down the socket for a `degraded` or `down` entry. That is a reply
// on a live connection, not a fact about a row: it belongs to whatever transport
// holds the socket, and this method returns the recorded rows so such a
// transport can decide from the same values.

import { err, ok, runResult, type EntityId, type Result } from "@platos/kernel";

import {
  applyReport,
  asToolsIdentifier,
  entityNotInScope,
  freshHealth,
  healthReportInvalid,
  isHealthReport,
  type ExternalEntityId,
  type HealthReport,
  type ToolHealth,
  type ToolHealthId,
  type ToolName,
} from "../domain/index.js";
import { requireAccess, withOperator } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";

/** One entry of the heartbeat's `tools_health` map, named. */
export interface ToolHealthReportIntake {
  readonly toolName: string;
  /** `healthy`, `degraded` or `down`. Validated: it arrives from a wire frame. */
  readonly status: string;
  /**
   * The entity's OWN average over its own window. Absent becomes zero, which is
   * what `healthEntry.avg_latency_ms ?? 0` writes.
   */
  readonly avgLatencyMs?: number | null;
}

export interface RecordToolHealthCommand {
  readonly authorization: unknown;
  readonly entityId: EntityId;
  /** The entity's own name for itself. Verified against the tenancy record. */
  readonly externalEntityId: ExternalEntityId;
  readonly reports: readonly ToolHealthReportIntake[];
}

export interface RecordedToolHealth {
  /** One row per report this scope could place, in the order they were sent. */
  readonly recorded: readonly ToolHealth[];
  /**
   * Names the heartbeat carried that this entity exposes nowhere in this
   * environment. Skipped, exactly as the oracle skips them, and reported so the
   * skip is visible rather than silent.
   */
  readonly unknownToolNames: readonly ToolName[];
}

export async function recordToolHealth(
  dependencies: ToolsDependencies,
  command: RecordToolHealthCommand,
): Promise<Result<RecordedToolHealth>> {
  return withOperator(dependencies, command.authorization, async (grant) => {
    // `secret:mutate`, the same level `registerTools` demands, and for the same
    // reason rather than by imitation: both are writes made on behalf of one
    // entity's backend, and an operator who may not reconfigure an environment's
    // tools may not mark them all `down` either — which is a denial of every
    // tool in the environment to every model, achieved through a read-level
    // grant.
    const permitted = requireAccess(grant, "secret:mutate");
    if (!permitted.ok) return err(permitted.error);
    const scope = grant.scope;

    // EVERY REPORT IS VALIDATED BEFORE ANY ROW IS READ. A frame carrying one bad
    // status is one bad frame; recording the good half of it would leave a
    // partially applied heartbeat whose failure the caller is also told about.
    for (const report of command.reports) {
      if (!isHealthReport(report.status)) {
        return err(healthReportInvalid(report.toolName, String(report.status)));
      }
    }

    // THE ENTITY IS TENANCY'S, AND BOTH IDENTIFIERS MUST AGREE WITH THE RECORD.
    // The same check `registerTools` makes and for the same reason, which is
    // sharper here: `ToolHealth.entityExternalId` is written from
    // `externalEntityId`, so a caller that supplied a real entity id and somebody
    // else's external id would file this entity's health under that one's name.
    const entity = await dependencies.tenancy.findEntity(command.entityId);
    if (!entity.ok) return err(entity.error);
    if (
      entity.value.externalId !== command.externalEntityId ||
      entity.value.projectId !== scope.projectId
    ) {
      return err(entityNotInScope(command.entityId));
    }

    const exposures = await dependencies.repository.listEntityExposures(scope, command.entityId);
    if (!exposures.ok) return err(exposures.error);
    const byName = new Map(exposures.value.map((exposure) => [exposure.toolName, exposure]));

    const at = dependencies.clock.now();
    const unknownToolNames: ToolName[] = [];

    return runResult(dependencies.unitOfWork, async () => {
      const recorded: ToolHealth[] = [];
      for (const report of command.reports) {
        const exposure = byName.get(report.toolName as ToolName);
        if (exposure === undefined) {
          unknownToolNames.push(report.toolName as ToolName);
          continue;
        }
        const existing = await dependencies.repository.findHealth(
          scope,
          exposure.toolId,
          command.externalEntityId,
        );
        if (!existing.ok) return err(existing.error);
        // A MISS MINTS THE ID HERE, which is what `saveHealth` upserts on. See
        // `execute-tool.ts`, which does the same for the call fold: the compound
        // unique key cannot address a row whose `entityExternalId` is null, so
        // the primary key is the only key the store can use.
        const base =
          existing.value ??
          freshHealth(
            asToolsIdentifier<ToolHealthId>(dependencies.ids.uuid()),
            scope.environmentId,
            exposure.toolId,
            command.externalEntityId,
            at,
          );
        const saved = await dependencies.repository.saveHealth(
          scope,
          // `report.status` is narrowed by the loop above; the cast is the
          // narrowing the `for` already performed, not a new claim.
          applyReport(base, report.status as HealthReport, report.avgLatencyMs ?? null, at),
        );
        if (!saved.ok) return err(saved.error);
        recorded.push(saved.value);
      }
      return ok({ recorded, unknownToolNames });
    });
  });
}
