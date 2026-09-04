// Turn an exposure into a callable target.
//
// This is where the fail-closed per-user invariant becomes a sequence of steps
// rather than a property, and the ORDER of those steps is the invariant:
//
//   1. read what the template demands. No I/O.
//   2. if it demands an end user and none is resolved — STOP. Nothing has been
//      read from the vault and nothing has touched the wire.
//   3. only now, if it demands a secret, ask `secrets` for one.
//   4. substitute.
//   5. scan the RESULT for a surviving token and refuse if one is there.
//
// Step 2 before step 3 is not an optimisation. A credential read is an audited
// event in `secrets`, and reading one for a call that was never going to happen
// leaves an operator looking at vault access for a dispatch that produced
// nothing. Step 5 after step 4 is the belt to step 2's braces: step 2 catches a
// missing INPUT, step 5 catches a substitution DEFECT, and only one of the two
// would survive a refactor of the other.
//
// A WIRE ENTITY HAS NO TEMPLATE AND STILL COMES THROUGH HERE. Its callback URL
// is already absolute and its headers are empty, so every step above is a
// no-op — but the target it produces is the same shape, so `execute-tool.ts`
// has one path and not two. The place the two transports genuinely differ is
// `domain/exposure.ts`'s `dispatchabilityOf`, which is data.

import { err, ok, type EntityId, type EnvironmentScope, type Result } from "@platos/kernel";

import type { EnvironmentAuthorization } from "@platos/context-secrets";

import {
  assertNoResidual,
  credentialFingerprintSource,
  endUserRequired,
  entityNotDispatchable,
  normalizeHeaderTemplate,
  resolveTransport as resolveTemplate,
  sessionPoolKey,
  templateRequirements,
  type ConnectionKind,
  type EntityMcpClient,
  type ExternalEntityId,
  type ToolExposure,
  type ToolName,
} from "../domain/index.js";
import type { ToolsDependencies } from "./dependencies.js";
import type { DispatchTarget } from "./ports/index.js";

/**
 * What resolution actually needs.
 *
 * NOT a `ToolExposure`. Discovery has no exposure to offer — it runs BEFORE any
 * exists, which is the point of it — and the earlier shape forced it to invent
 * a hollow one with blank ids. The five fields below are the whole input, and
 * `subjectOf` is the one place an exposure becomes one, so the two callers
 * cannot resolve against different rules.
 */
export interface TransportSubject {
  readonly entityId: EntityId;
  readonly externalEntityId: ExternalEntityId;
  readonly connectionKind: ConnectionKind;
  readonly callbackUrl: string;
  readonly dispatchable: boolean;
  /** Named only so a fail-closed refusal can say which tool wanted the user. */
  readonly toolName: ToolName;
}

export function subjectOf(exposure: ToolExposure): TransportSubject {
  return {
    entityId: exposure.entityId,
    externalEntityId: exposure.externalEntityId,
    connectionKind: exposure.connectionKind,
    callbackUrl: exposure.callbackUrl,
    dispatchable: exposure.dispatchable,
    toolName: exposure.toolName,
  };
}

export interface ResolveTargetCommand {
  readonly scope: EnvironmentScope;
  readonly subject: TransportSubject;
  /** The resolved end-user identity for this turn, or null when there is none. */
  readonly endUserId: string | null;
  /**
   * The vault grant `secrets` demands before it will read material. Supplied by
   * the composition root; this context cannot mint one and does not try.
   */
  readonly vaultAuthorization: EnvironmentAuthorization;
}

export async function resolveDispatchTarget(
  dependencies: ToolsDependencies,
  command: ResolveTargetCommand,
): Promise<Result<DispatchTarget>> {
  const subject = command.subject;
  if (!subject.dispatchable) {
    return err(entityNotDispatchable(subject.entityId, "the entity has no live transport"));
  }

  if (subject.connectionKind === "wire") {
    return ok({
      kind: "wire",
      externalEntityId: subject.externalEntityId,
      url: subject.callbackUrl === "" ? null : subject.callbackUrl,
      headers: {},
      sessionKey: `wire/${command.scope.environmentId}/${subject.externalEntityId}`,
      timeoutMs: dependencies.policy.dispatch.wireTimeoutMs,
    });
  }

  const client = await dependencies.repository.findMcpClient(command.scope, subject.entityId);
  if (!client.ok) return err(client.error);
  if (client.value === null) {
    return err(entityNotDispatchable(subject.entityId, "the entity has no MCP client configuration"));
  }
  return resolveMcpTarget(dependencies, command, client.value);
}

async function resolveMcpTarget(
  dependencies: ToolsDependencies,
  command: ResolveTargetCommand,
  client: EntityMcpClient,
): Promise<Result<DispatchTarget>> {
  const template = normalizeHeaderTemplate(client.headersTemplate, client.credentialName !== null);
  const required = templateRequirements(template, client.url);

  // Step 2 — the guard, before any read. `resolveTemplate` refuses on the same
  // condition, but only after this function would already have fetched a secret
  // for a call that is not going to happen. The refusal is duplicated here on
  // purpose: this one is about WHEN, the one in the domain is about WHETHER.
  if (required.needsEndUser && (command.endUserId === null || command.endUserId === "")) {
    return err(endUserRequired(command.subject.toolName));
  }

  let secret: string | null = null;
  if (required.needsSecret) {
    if (client.credentialName === null) {
      return err(
        entityNotDispatchable(
          command.subject.entityId,
          "the header template names a secret and the client has no credential",
        ),
      );
    }
    const material = await dependencies.secrets.readSecret({
      authorization: command.vaultAuthorization,
      name: client.credentialName,
    });
    if (!material.ok) return err(material.error);
    // The one place this package unwraps plaintext. `SecretMaterial` redacts
    // itself under JSON, string coercion and inspection, so the value stays
    // invisible everywhere except the substitution it was fetched for.
    secret = material.value.reveal();
  }

  const resolved = resolveTemplate({
    template,
    urlTemplate: client.url,
    secret,
    endUserId: command.endUserId,
    toolName: command.subject.toolName,
  });
  if (!resolved.ok) return err(resolved.error);

  const scanned = assertNoResidual(resolved.value);
  if (!scanned.ok) return err(scanned.error);

  const fingerprint = dependencies.digest.sha256Hex(
    credentialFingerprintSource(scanned.value.headers),
  );
  return ok({
    kind: "mcp",
    externalEntityId: command.subject.externalEntityId,
    url: scanned.value.url,
    headers: scanned.value.headers,
    sessionKey: sessionPoolKey(scanned.value.url, fingerprint),
    timeoutMs: dependencies.policy.dispatch.mcpTimeoutMs,
  });
}
