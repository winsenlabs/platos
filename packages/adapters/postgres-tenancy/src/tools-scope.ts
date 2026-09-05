// The tenant clause, as a statement rather than as a comparison.
//
// `ToolsRepository`'s port note is explicit: every scoped method takes an
// `EnvironmentScope` and not an `environmentId`, "so an adapter's `where` clause
// is built from the organization and project as well as the leaf. A repository
// method keyed on the leaf alone would happily read an environment that has
// since been re-parented." The in-memory double honours that by comparing
// `resolvePath(scope)` against the one scope it was constructed with. An adapter
// has no such constant to compare against — the tree is in the database — so the
// same sentence becomes a SELECT that resolves the leaf THROUGH its project to
// its organization, and refuses when the three do not join up.
//
// ONE STATEMENT, AND IT IS THE SAME ONE FOR EVERY METHOD. Folding the ancestry
// into each read's own `where` would have been one statement fewer, and would
// also have made "this scope is a lie" indistinguishable from "this environment
// holds no tools" on every read that returns a list. The scoped methods of this
// port return `Result`, so the difference is expressible, and it is worth a
// statement to express it.
//
// TWO REFUSALS, TWO REASONS, AND ONLY ONE OF THEM IS SHARED WITH THE DOUBLE.
// `out_of_scope` is what the double raises and is therefore what the shared
// conformance transcript records; `unknown_environment` is a fact the double
// cannot have — it holds no tree — and is minted here so an operator can tell a
// forged ancestry from a deleted environment without reading a message. Both
// travel as `repositoryUnavailable`, whose `details.reason` carries them.

import type {
  EnvironmentScope,
  Result,
} from "@platos/context-tools/application/ports/index.js";
import { err, ok, repositoryUnavailable } from "@platos/context-tools/application/ports/index.js";

import type { TenancyTransactions } from "./transaction.js";

/** The scope names an environment that is not under the project it claims. */
export const TOOLS_SCOPE_FOREIGN = "out_of_scope";

/** The scope names an environment that does not exist at all. */
export const TOOLS_SCOPE_UNKNOWN = "unknown_environment";

/** Resolve a scope against the tree, or refuse. Costs exactly one statement. */
export async function requireScope(
  transactions: TenancyTransactions,
  scope: EnvironmentScope,
  operation: string,
): Promise<Result<true>> {
  const environment = await transactions.reader().environment.findUnique({
    where: { id: scope.environmentId },
    // The PROJECT's organization, not the environment's — the environment has
    // no organization column, and that is exactly why a leaf-keyed method
    // cannot notice a re-parent.
    select: { projectId: true, project: { select: { organizationId: true } } },
  });
  if (environment === null) {
    return err(repositoryUnavailable(`${TOOLS_SCOPE_UNKNOWN}:${operation}`));
  }
  if (
    environment.projectId !== scope.projectId ||
    environment.project.organizationId !== scope.organizationId
  ) {
    return err(repositoryUnavailable(`${TOOLS_SCOPE_FOREIGN}:${operation}`));
  }
  return ok(true);
}

/**
 * Run `work` once the scope resolves, and turn a driver failure into a refusal.
 *
 * EVERY METHOD OF THIS PORT RETURNS `Result`, and the port says why: "a store
 * failure is a business outcome the caller must handle, not an exception that
 * unwinds through a use case, and a vendor error type must not cross this line."
 * This is the one place that promise is kept, so no store method below has to
 * remember to keep it.
 *
 * A `TransactionScopeError` is deliberately NOT caught. It means a write was
 * issued outside the unit of work, or inside the wrong one — a defect in the
 * composition, not an outcome a use case can handle — and swallowing it into a
 * `Result` would let a write that never ran look like a store that was busy.
 */
export async function inScope<Value>(
  transactions: TenancyTransactions,
  scope: EnvironmentScope,
  operation: string,
  work: () => Promise<Result<Value>>,
): Promise<Result<Value>> {
  const resolved = await requireScope(transactions, scope, operation);
  if (!resolved.ok) return err(resolved.error);
  return guarded(operation, work);
}

/** The driver-failure half, for the two methods that take no scope. */
export async function guarded<Value>(
  operation: string,
  work: () => Promise<Result<Value>>,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionScopeError") throw error;
    return err(repositoryUnavailable(`${operation}:${driverCode(error)}`));
  }
}

/** The driver's own code, so a refusal names the failure it came from. */
function driverCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}
