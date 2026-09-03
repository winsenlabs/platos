// Use cases: read job definitions.
//
// Reads are separated from the write paths because they answer a different
// question and carry a different risk. The only judgement in this file is which
// projection a caller gets, and it is made once here rather than at each call
// site — see `views.ts` for why the handler-bearing projection is opt-in.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import { jobNotFound, type JobId, type JobKey } from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import { toJobSourceView, toJobView, type JobSourceView, type JobView } from "./views.js";

export interface DescribeJobQuery {
  readonly scope: EnvironmentScope;
  readonly jobId: JobId;
}

export interface DescribeJobByKeyQuery {
  readonly scope: EnvironmentScope;
  readonly jobKey: JobKey;
}

/** The safe projection: no handler source. */
export async function describeJob(
  dependencies: JobsDependencies,
  query: DescribeJobQuery,
): Promise<Result<JobView>> {
  const found = await dependencies.jobs.findJob(query.scope, query.jobId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(jobNotFound(query.jobId));
  return ok(toJobView(found.value));
}

/**
 * The projection WITH the handler source. A separate function, and a separate
 * call, so revealing the source is always something a caller chose to do.
 */
export async function readJobSource(
  dependencies: JobsDependencies,
  query: DescribeJobQuery,
): Promise<Result<JobSourceView>> {
  const found = await dependencies.jobs.findJob(query.scope, query.jobId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(jobNotFound(query.jobId));
  return ok(toJobSourceView(found.value));
}

export async function describeJobByKey(
  dependencies: JobsDependencies,
  query: DescribeJobByKeyQuery,
): Promise<Result<JobView>> {
  const found = await dependencies.jobs.findJobByKey(query.scope, query.jobKey);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(jobNotFound(query.jobKey));
  return ok(toJobView(found.value));
}

export async function listJobs(
  dependencies: JobsDependencies,
  scope: EnvironmentScope,
): Promise<Result<readonly JobView[]>> {
  const found = await dependencies.jobs.listJobs(scope);
  if (!found.ok) return err(found.error);
  return ok(found.value.map(toJobView));
}
