// Use case: synthesize the maintained narrative profile.
//
// The extraction judge only ever emits ATOMS — facts, preferences, events,
// relationships. Before consolidation existed, the PROFILE was written only by
// explicit profile calls, so it never kept up on its own. This rolls the atoms
// one agent holds about one subject into a short narrative and stores it as a
// `kind = "profile"` row under the reserved key the turn-start injector reads.
//
// THE ATOMS ARE READ ACROSS THE ACTING AGENT'S CLUSTER, and the profile is
// written as that agent. That asymmetry is deliberate and matches how memory is
// scoped everywhere else: a cluster shares what it knows, and the profile is a
// projection of what was shared, attributed to the agent that composed it.
//
// EVERY REFUSAL IS AN OUTCOME, NOT AN ERROR. `throttled`, `too-few-atoms` and
// `empty` all mean "no narrative was written, and nothing is wrong", and the
// caller — an extraction sweep — must not treat any of them as a failure. Only a
// store or model failure is an error, and the sweep that calls this is the one
// place in the context that decides how to react to it.
//
// THE THROTTLE READS ITS OWN OUTPUT rather than a lock or a cache, so it
// survives a restart and two workers racing write the same row rather than two.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitNarrative,
  clusterPeers,
  decideSynthesis,
  isSynthesizedProfile,
  profileCacheKey,
  renderAtoms,
  RUNTIME_RECALL_FILTER,
  synthesisMetadata,
  type AgentId,
  type EndUserId,
  type Memory,
  type MemorySubject,
  type SynthesisRefusal,
} from "../domain/index.js";
import { resolveReadScope, subjectFor, verifyGrant } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { priceJudgeAnswer } from "./judge-pricing.js";
import { remember } from "./remember.js";
import type { MemoryFilter } from "./ports/index.js";

export interface SynthesizeProfileCommand {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  /** Bypass the window. The manual "refresh profile" control sets it. */
  readonly force?: boolean;
  readonly throttleMs?: number;
}

export interface SynthesisReport {
  readonly written: boolean;
  readonly refusal: SynthesisRefusal | null;
  readonly atomCount: number;
  readonly memory: Memory | null;
  /** Canonical `Decimal(18, 6)` cents from `providers`, or null when unpriced. */
  readonly costCents: string | null;
}

export async function synthesizeProfile(
  dependencies: MemoryDependencies,
  command: SynthesizeProfileCommand,
): Promise<Result<SynthesisReport>> {
  const granted = verifyGrant(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const subject = subjectFor(granted.value, command);
  if (!subject.ok) return err(subject.error);

  const bindings = await dependencies.repository.listAgentBindings(subject.value.environment);
  if (!bindings.ok) return err(bindings.error);
  const acting = bindings.value.find((binding) => binding.agentId === subject.value.actingAgentId);
  const peers = acting === undefined ? [] : clusterPeers(bindings.value, acting);

  const scope = await resolveReadScope(
    dependencies,
    subject.value,
    peers.map((binding) => binding.agentId),
  );
  if (!scope.ok) return err(scope.error);

  const filter: MemoryFilter = {
    subject: scope.value.subject,
    agentIds: scope.value.agentIds,
    kind: null,
    source: null,
    visibilities: RUNTIME_RECALL_FILTER.visibilities,
    archiveState: "active",
    // Retrieval-augmented rows are dropped by `selectSynthesisAtoms` as well.
    // Excluding them here too means the model is never even shown one.
    excludeRag: true,
    excludeQuarantined: true,
  };
  const held = await dependencies.repository.listMemories(filter, MAX_ATOM_FETCH, 0);
  if (!held.ok) return err(held.error);

  const prior = held.value.find(isSynthesizedProfile) ?? null;
  const decision = decideSynthesis(held.value, prior, dependencies.clock.now(), {
    force: command.force,
    throttleMs: command.throttleMs ?? dependencies.policy.profile.synthesisThrottleMs,
  });
  if (!decision.proceed) {
    return ok({ written: false, refusal: decision.reason, atomCount: 0, memory: null, costCents: null });
  }

  const answered = await dependencies.judge.synthesize(renderAtoms(decision.atoms));
  if (!answered.ok) return err(answered.error);
  const costCents = await priceJudgeAnswer(dependencies, answered.value);

  const narrative = admitNarrative(answered.value.text);
  if (narrative === null) {
    return ok({
      written: false,
      refusal: "empty",
      atomCount: decision.atoms.length,
      memory: null,
      costCents,
    });
  }

  const now = dependencies.clock.now();
  const stored = await remember(dependencies, {
    authorization: command.authorization,
    endUserId: command.endUserId,
    actingAgentId: subject.value.actingAgentId,
    requestedAgentId: null,
    kind: "profile",
    content: narrative,
    metadata: synthesisMetadata(now, decision.atoms.length),
    visibility: "agent_visible",
    agentVisible: true,
    source: "manual",
    sourceThreadId: null,
    sourceTurnIds: [],
    extractorVersion: null,
    confidence: null,
  });
  if (!stored.ok) return err(stored.error);

  await invalidateProfileCache(dependencies, scope.value.subject, subject.value.actingAgentId);
  return ok({
    written: true,
    refusal: null,
    atomCount: decision.atoms.length,
    memory: stored.value,
    costCents,
  });
}

/**
 * How many rows are read before the atoms are selected.
 *
 * Wider than the eighty atoms the model is shown, because the page also has to
 * contain the PRIOR synthesized profile — the row the throttle is read from. A
 * window of exactly eighty could, for a subject with many memories, page the
 * profile out and re-synthesize on every sweep.
 */
export const MAX_ATOM_FETCH = 100;

/**
 * Drop the cached projection so the next reader sees the new narrative.
 *
 * Best-effort. The cache's ten-minute lifetime is what bounds the damage of a
 * missed invalidation, which is why that TTL is short and stated in the policy
 * rather than left to an adapter.
 */
async function invalidateProfileCache(
  dependencies: MemoryDependencies,
  subject: MemorySubject,
  agentId: AgentId | null,
): Promise<void> {
  if (agentId === null) return;
  await dependencies.cache.delete(profileCacheKey(subject.environment, agentId, subject.endUserId));
}
