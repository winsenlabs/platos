// The store behind `PostmanExecution`, the fourth row this context owns.
//
// ITS OWN PORT, BECAUSE IT IS ITS OWN LIFETIME. A postman execution outlives the
// turn it produced — that is what makes it an audit row rather than a field on
// the turn — and it is created BEFORE any thread or turn exists, which is why
// `threadId` and `turnId` are both nullable on the row and are filled in at
// settlement.
//
// TWO LOOKUPS, TWO CONSTRAINTS. `findByRequest` answers
// `@@unique([templateId, requestId])`, which is what makes a replay
// distinguishable from a first call. `findByHandle` answers
// `contextHandle @unique`, which is the capability an operator holds. They are
// separate methods because they are separate questions asked by separate callers
// — one by the launcher, one by whoever came back for the result.
//
// NEITHER LOOKUP TAKES THE HANDLE AS A LOG FIELD. The handle is a capability;
// `postman-execution.ts` says so and brands it. An adapter that logged this
// parameter would publish it, which is why the port names it once, in the one
// method that has to compare it.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type {
  ActorId,
  PostmanContextHandle,
  PostmanExecution,
  PostmanExecutionId,
  PostmanTemplateId,
} from "../../domain/index.js";

export interface PostmanPageQuery {
  readonly scope: EnvironmentScope;
  /** Null reads every operator's executions. */
  readonly actorUserId: ActorId | null;
  readonly limit: number;
  readonly offset: number;
}

export interface PostmanPage {
  readonly items: readonly PostmanExecution[];
  readonly total: number;
}

export interface PostmanRepository {
  findExecution(
    scope: EnvironmentScope,
    executionId: PostmanExecutionId,
  ): Promise<Result<PostmanExecution | null>>;

  /**
   * The execution a `[template, request]` pair already produced, if any.
   *
   * `templateId` is nullable on the row — an ad-hoc request has no template — and
   * the unique constraint is on the pair, so a null template makes the
   * constraint vacuous. That is the schema's behaviour and this method reports
   * it faithfully: a null template answers null, and the caller creates.
   */
  findByRequest(
    scope: EnvironmentScope,
    templateId: PostmanTemplateId | null,
    requestId: string,
  ): Promise<Result<PostmanExecution | null>>;

  findByHandle(
    scope: EnvironmentScope,
    handle: PostmanContextHandle,
  ): Promise<Result<PostmanExecution | null>>;

  pageExecutions(query: PostmanPageQuery): Promise<Result<PostmanPage>>;
  createExecution(scope: EnvironmentScope, execution: PostmanExecution): Promise<Result<PostmanExecution>>;
  saveExecution(scope: EnvironmentScope, execution: PostmanExecution): Promise<Result<PostmanExecution>>;
}
