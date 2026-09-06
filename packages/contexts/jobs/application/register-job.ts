// Use case: register a job definition in an environment.
//
// ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. The live tool validates, then
// checks for a duplicate, THEN syntax-checks the handler, then inserts. Syntax
// checking last is deliberate: it is the only step that runs caller-supplied text
// through a parser, and doing it after the cheap refusals means a caller cannot
// use a job-creation endpoint as a free parser for source it has no permission to
// register.
//
// A HANDLER THAT DOES NOT PARSE STILL CREATES A ROW. It is stored with
// `registration-failed` and the parse error is returned alongside it. Discarding
// the row instead would leave an author with an error message and nothing to fix.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitJobDefinition,
  jobAlreadyExists,
  registrationStatus,
  type Job,
  type JobDefinitionDraft,
} from "../domain/index.js";
import type { EnvironmentScope } from "@platos/kernel";
import type { JobsDependencies } from "./dependencies.js";
import { asJobId } from "./minting.js";

export interface RegisterJobCommand {
  readonly scope: EnvironmentScope;
  readonly draft: JobDefinitionDraft;
  readonly createdBy: string;
}

export interface RegisterJobResult {
  readonly job: Job;
  /** Non-null when the handler did not parse; the row is `registration-failed`. */
  readonly syntaxError: string | null;
}

export async function registerJob(
  dependencies: JobsDependencies,
  command: RegisterJobCommand,
): Promise<Result<RegisterJobResult>> {
  const definition = admitJobDefinition(command.draft);
  if (!definition.ok) return err(definition.error);

  const existing = await dependencies.jobs.findJobByKey(command.scope, definition.value.jobKey);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) return err(jobAlreadyExists(definition.value.jobKey));

  const syntax = await dependencies.handlers.checkSyntax(definition.value.handler);
  if (!syntax.ok) return err(syntax.error);

  const now = dependencies.clock.now();
  const job: Job = {
    jobId: asJobId(dependencies.ids.uuid()),
    jobKey: definition.value.jobKey,
    displayName: definition.value.displayName,
    description: definition.value.description,
    invocationType: definition.value.invocationType,
    schedule: definition.value.schedule,
    allowedAgentIds: definition.value.allowedAgentIds,
    payloadSchema: definition.value.payloadSchema,
    handler: definition.value.handler,
    budget: definition.value.budget,
    status: registrationStatus(syntax.value),
    createdBy: command.createdBy,
    lastStartedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.jobs.insertJob(command.scope, job, transaction),
  );
  if (!inserted.ok) return err(inserted.error);
  return ok({ job: inserted.value, syntaxError: syntax.value });
}
