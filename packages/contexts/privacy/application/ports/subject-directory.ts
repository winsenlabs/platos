// The `SubjectDirectory` port — how a handle becomes a person.
//
// WHY THIS IS A PORT AND NOT AN IMPORT
//
// Resolving "which rows is this person" means reading identity rows, and
// `identity-access` owns those. ADR M0.3 §1 permits `privacy` exactly two
// dependencies, `tenancy` and the kernel, so this context cannot ask
// identity-access directly — and must not, because the whole §3 graft exists to
// keep privacy off every other context's surface.
//
// This is NOT the fan-in shape §3 rejects. That was "privacy defines an
// interface every context implements", which puts privacy at the centre of a
// cycle. This is one ordinary driven port with one adapter, owned by the context
// whose capability it serves (§13). The composition root wires it, and it is the
// composition root — not this package — that is allowed to know identity-access
// exists.
//
// WHAT IT RETURNS, AND WHY BOTH HALVES ARE NEEDED
//
// `subjects` is what the kernel `ErasureTarget`s are addressed by: one
// `ErasureSubject` per (kind, id, scope) the person occupies. A person routinely
// spans several scopes, and a target planning against one scope must not be
// asked to certify another.
//
// `aliases` is what the BARRIER is sealed from, and it is deliberately wider
// than `subjects`. A resolver that returned only the id it was asked about would
// let the same person walk back in through their Slack handle after their email
// was erased. It must include handles already disabled — the sweep deletes those
// rows too — and the canonical row id, for asynchronous writers that captured it
// before the sweep.
//
// FAILURE IS A VALUE. A directory that cannot answer must not read as "this
// person has no data": `subjectDirectoryUnavailable` keeps the operation open
// instead of certifying an empty sweep.

import type { ErasureSubject, OrganizationId, Result } from "@platos/kernel";

import type { SubjectAlias } from "../../domain/index.js";

export interface SubjectQuery {
  readonly organizationId: OrganizationId;
  /**
   * The handle the caller named. Never assumed to be the canonical id: the
   * defect this whole context was rebuilt around is a route that took one id and
   * missed every row linked by the other.
   */
  readonly externalUserId: string;
}

export interface ResolvedSubject {
  /** One kernel subject per (kind, id, scope) the person occupies. */
  readonly subjects: readonly ErasureSubject[];
  /** Every handle the person can be addressed by. Sealed as tombstones. */
  readonly aliases: readonly SubjectAlias[];
}

export interface SubjectDirectory {
  resolve(query: SubjectQuery): Promise<Result<ResolvedSubject>>;
}
