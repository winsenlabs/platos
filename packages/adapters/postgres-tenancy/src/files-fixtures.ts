// The two aggregate builders the constraint, rule, transaction and statement
// suites share.
//
// ONE BUILDER PER AGGREGATE, taking an override bag, because every case in those
// suites is "a correct value with ONE field wrong". Spelling the other eleven
// fields out at each of sixty call sites would have made the wrong field the
// hardest thing in the case to find — and a case whose fixture differs from its
// neighbour's in a field nobody meant to change is a case measuring something
// else.
//
// THE DEFAULTS ARE A VALUE THE DATABASE ACCEPTS. That is what makes an override
// the only variable: when a case goes red, the rule that refused it is the one
// the override reached.
//
// `files-conformance.ts` deliberately does NOT use these. Its values have to be
// identical on both sides of a differential and are minted from a counter it
// owns; sharing a builder would have let a default drift under a scenario whose
// whole claim is that two runs saw the same thing.

import type {
  ArtifactId,
  ArtifactKey,
  ArtifactRevision,
  Attachment,
  AttachmentId,
  AttachmentScope,
  ContentHash,
  EnvironmentScope,
  FilesErasureSelector,
  JsonValue,
  OrganizationScope,
  PrincipalId,
  StorageKey,
  ThreadScope,
  TurnId,
} from "@platos/context-files/application/ports/index.js";
import { asIdentifier, boundTo, PENDING_BINDING } from "@platos/context-files/application/ports/index.js";

// Typed identifier constructors. A bare `asIdentifier("x")` infers the GENERIC
// brand, which every branded parameter then rejects — and inside an object
// literal there is no contextual type to rescue it, which is where the four
// scope builders below earn their place. The brand is named once, here, rather
// than at each of forty call sites.
export const orgIdOf = (value: string): OrganizationScope["organizationId"] =>
  asIdentifier<OrganizationScope["organizationId"]>(value);
export const projIdOf = (value: string): EnvironmentScope["projectId"] =>
  asIdentifier<EnvironmentScope["projectId"]>(value);
export const envIdOf = (value: string): EnvironmentScope["environmentId"] =>
  asIdentifier<EnvironmentScope["environmentId"]>(value);
export const endUserIdOf = (value: string): AttachmentScope["owner"]["endUserId"] =>
  asIdentifier<AttachmentScope["owner"]["endUserId"]>(value);
export const threadIdOf = (value: string): ThreadScope["threadId"] =>
  asIdentifier<ThreadScope["threadId"]>(value);

export function organizationScopeOf(organizationId: string): OrganizationScope {
  return { level: "organization", organizationId: orgIdOf(organizationId) };
}

/** One selector, addressed at an organization — the widest an erasure can be. */
export function erasureSelectorOf(
  organizationId: string,
  endUserId: string | null,
  principalId: string | null,
): FilesErasureSelector {
  return { scope: organizationScopeOf(organizationId), endUserId, principalId };
}

/** The one instant every fixture row is stamped with, so nothing is time-dependent. */
export const FILES_AT = new Date("2026-06-01T09:00:00.000Z");

/** A week after `FILES_AT`. Every pending attachment in the suites expires here. */
export const FILES_EXPIRES = new Date("2026-06-08T09:00:00.000Z");

export interface AttachmentOverrides {
  readonly attachmentId?: string;
  readonly scope?: AttachmentScope;
  readonly turnId?: string | null;
  readonly kind?: string;
  readonly mimeType?: string;
  readonly bytes?: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationSeconds?: number | null;
  readonly storageKey?: string;
  readonly originalName?: string | null;
  readonly contentHash?: string | null;
  readonly createdAt?: Date;
  readonly expiresAt?: Date | null;
}

export function attachmentFixture(
  scope: AttachmentScope,
  attachmentId: string,
  overrides: AttachmentOverrides = {},
): Attachment {
  const id = asIdentifier<AttachmentId>(overrides.attachmentId ?? attachmentId);
  const turnId = overrides.turnId ?? null;
  return {
    attachmentId: id,
    scope: overrides.scope ?? scope,
    binding: turnId === null ? PENDING_BINDING : boundTo(asIdentifier<TurnId>(turnId)),
    kind: overrides.kind ?? "document",
    mimeType: overrides.mimeType ?? "application/pdf",
    bytes: overrides.bytes ?? 1024,
    media: {
      width: overrides.width ?? null,
      height: overrides.height ?? null,
      durationSeconds: overrides.durationSeconds ?? null,
    },
    storageKey: asIdentifier<StorageKey>(overrides.storageKey ?? `fixture/${id}/file.pdf`),
    originalName: overrides.originalName === undefined ? "file.pdf" : overrides.originalName,
    contentHash:
      overrides.contentHash === undefined || overrides.contentHash === null
        ? null
        : asIdentifier<ContentHash>(overrides.contentHash),
    createdAt: overrides.createdAt ?? FILES_AT,
    expiresAt: overrides.expiresAt === undefined ? FILES_EXPIRES : overrides.expiresAt,
  };
}

export interface ArtifactOverrides {
  readonly artifactId?: string;
  readonly scope?: ThreadScope;
  readonly artifactKey?: string;
  readonly revision?: number;
  readonly kind?: string;
  readonly title?: string | null;
  readonly mimeType?: string | null;
  readonly content?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>> | null;
  readonly producedByTurnId?: string | null;
  readonly createdBy?: string;
  readonly createdAt?: Date;
}

export function artifactFixture(
  scope: ThreadScope,
  artifactId: string,
  overrides: ArtifactOverrides = {},
): ArtifactRevision {
  const producedByTurnId = overrides.producedByTurnId ?? null;
  return {
    artifactId: asIdentifier<ArtifactId>(overrides.artifactId ?? artifactId),
    scope: overrides.scope ?? scope,
    artifactKey: asIdentifier<ArtifactKey>(overrides.artifactKey ?? "report.summary"),
    revision: overrides.revision ?? 1,
    kind: overrides.kind ?? "markdown",
    title: overrides.title === undefined ? "the summary" : overrides.title,
    mimeType: overrides.mimeType === undefined ? "text/markdown" : overrides.mimeType,
    content: overrides.content ?? "# the summary",
    metadata: overrides.metadata === undefined ? null : overrides.metadata,
    producedByTurnId:
      producedByTurnId === null ? null : asIdentifier<TurnId>(producedByTurnId),
    createdBy: asIdentifier<PrincipalId>(overrides.createdBy ?? "user_fixture_author"),
    createdAt: overrides.createdAt ?? FILES_AT,
  };
}

/**
 * The operator-facing code an adapter refusal carries, or a marker naming what
 * arrived instead.
 *
 * Every store failure in this context collapses to `FILES_REPOSITORY_UNAVAILABLE`
 * for the caller, and the distinct code LEADS `details.reason`. A case that
 * matched on the caller-facing code alone would pass against any refusal at all,
 * which is exactly the collapse these suites exist to see through.
 */
export function refusalCode(result: { readonly ok: boolean } | null): string {
  if (result === null || result.ok) return "<not-a-refusal>";
  const error = (result as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "<uncoded>";
  const details = (error as { readonly details?: unknown }).details;
  if (typeof details !== "object" || details === null) return "<no-details>";
  const reason = (details as { readonly reason?: unknown }).reason;
  if (typeof reason !== "string") return "<no-reason>";
  const separator = reason.indexOf(":");
  return separator < 0 ? reason : reason.slice(0, separator);
}

/**
 * The WHOLE `details.reason`, for the refusals whose evidence is the database's
 * own message.
 *
 * A guard's reason begins with a code this package minted; a driver error's
 * begins with the METHOD and carries the constraint or trigger PostgreSQL named.
 * A case about a rule that lives only in the migrations has to be able to assert
 * that the rule is what refused it, and the name PostgreSQL prints is the only
 * thing in the refusal that says so.
 */
export function refusalReason(result: { readonly ok: boolean }): string {
  if (result.ok) return "<not-a-refusal>";
  const error = (result as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "<uncoded>";
  const details = (error as { readonly details?: unknown }).details;
  if (typeof details !== "object" || details === null) return "<no-details>";
  const reason = (details as { readonly reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "<no-reason>";
}

/** The caller-facing code, which every refusal in this context shares. */
export function callerCode(result: { readonly ok: boolean }): string {
  if (result.ok) return "<not-a-refusal>";
  const error = (result as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "<uncoded>";
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : "<uncoded>";
}
