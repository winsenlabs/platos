// Use case: validate and store an `agentRouting` table.
//
// THE FORGED-ID GUARD LIVES HERE, AND IT IS A WRITE-TIME GUARD ON PURPOSE.
// Every agent a rule names must belong to the environment that owns the row. If
// that is checked only when a message arrives, a table that points at another
// tenant's agent is STORED, and the failure surfaces at inbound time as a
// dropped customer message rather than at configuration time as a rejected edit.
// Checking on write means an out-of-scope agent is unreachable by construction:
// the stored table cannot contain one, so the read path never has to ask.
//
// ONE BATCHED QUERY, never one per rule. The cap is 32 rules, the distinct ids
// are usually far fewer, and a per-rule query would make an operator's save
// latency depend on how elaborate their routing is.
//
// NORMALIZATION HAPPENS BEFORE THE GUARD. `normalizeAgentRouting` is pure and
// cheap and rejects the common mistakes; there is no reason to spend a database
// round trip proving the agents exist for a table that is malformed anyway.

import { err, ok, type Result } from "@platos/kernel";

import {
  appNotFound,
  connectionNotFound,
  normalizeAgentRouting,
  referencedAgentIds,
  routingAgentUnknown,
  type ChannelApp,
  type ChannelAppId,
  type ChannelConnection,
  type ChannelConnectionId,
  type ChannelRoutingRule,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

type Dependencies = Pick<ChannelsDependencies, "repository" | "agents" | "unitOfWork">;

export interface ConfigureConnectionRoutingCommand {
  readonly scope: ChannelConnection["scope"];
  readonly connectionId: ChannelConnectionId;
  /** Raw, as supplied by an operator. Normalized and checked here. */
  readonly agentRouting: unknown;
}

export interface ConfigureAppRoutingCommand {
  readonly scope: ChannelApp["scope"];
  readonly appId: ChannelAppId;
  readonly agentRouting: unknown;
}

/**
 * The guard itself, shared by both surfaces.
 *
 * Reports EVERY unknown id, not just the first. An operator fixing a 32-rule
 * table one rejected id per save is the failure mode this avoids.
 */
export async function assertAgentsInScope(
  dependencies: Pick<ChannelsDependencies, "agents">,
  environmentId: string,
  rules: readonly ChannelRoutingRule[],
): Promise<Result<readonly ChannelRoutingRule[]>> {
  const referenced = referencedAgentIds(rules);
  if (referenced.length === 0) return ok(rules);

  const found = await dependencies.agents.agentsInEnvironment(environmentId, referenced);
  if (!found.ok) return err(found.error);

  const present = new Set(found.value);
  const missing = referenced.filter((agentId) => !present.has(agentId));
  if (missing.length > 0) return err(routingAgentUnknown(missing));
  return ok(rules);
}

async function admitRouting(
  dependencies: Dependencies,
  environmentId: string,
  raw: unknown,
): Promise<Result<readonly ChannelRoutingRule[]>> {
  const normalized = normalizeAgentRouting(raw);
  if (!normalized.ok) return err(normalized.error);
  return assertAgentsInScope(dependencies, environmentId, normalized.value);
}

export async function configureConnectionRouting(
  dependencies: Dependencies,
  command: ConfigureConnectionRoutingCommand,
): Promise<Result<ChannelConnection>> {
  const found = await dependencies.repository.findConnection(command.scope, command.connectionId);
  if (!found.ok) return err(found.error);
  const connection = found.value;
  if (connection === null) return err(connectionNotFound(command.connectionId));

  const rules = await admitRouting(dependencies, command.scope.environmentId, command.agentRouting);
  if (!rules.ok) return err(rules.error);

  return dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.saveConnection({ ...connection, agentRouting: rules.value }, transaction),
  );
}

export async function configureAppRouting(
  dependencies: Dependencies,
  command: ConfigureAppRoutingCommand,
): Promise<Result<ChannelApp>> {
  const found = await dependencies.repository.findApp(command.scope, command.appId);
  if (!found.ok) return err(found.error);
  const app = found.value;
  if (app === null) return err(appNotFound(command.appId));

  const rules = await admitRouting(dependencies, command.scope.environmentId, command.agentRouting);
  if (!rules.ok) return err(rules.error);

  return dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.saveApp({ ...app, agentRouting: rules.value }, transaction),
  );
}
