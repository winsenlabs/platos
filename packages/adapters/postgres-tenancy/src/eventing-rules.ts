// The seven CRUD-and-read halves of `NotificationRuleRepository`.
//
// EVERY READ IS SCOPED AND THE SCOPE IS A PARAMETER, WHICH IS THE PORT'S OWN
// POINT: "There is no `findRule(id)`. There is `findRule(scope, id)`, and an
// implementation MUST return `null` — not a row from another environment — when
// the id exists elsewhere." `scopedWhere` is spread into every one of them, and
// it walks the whole ancestry rather than the leaf column, so a caller holding
// the right environment id under the wrong project gets `null` too.
//
// THE UNIQUE INDEX IS THE AUTHORITY ON A NAME, NOT THE PRE-FLIGHT.
// `register-notification-rule.ts` reads `findRuleByName` first and says in its
// own header why that is not the whole story: "the pre-flight closes the common
// case, and a racing insert still fails at the store, where the adapter maps it
// onto the same code". This file is that mapping. `@@unique([environmentId,
// name])` raises 23505, `isNameClash` recognises it, and the caller gets
// EVENTING_RULE_NAME_TAKEN — a `conflict`, not an outage.
//
// AND A CAUGHT CLASH LEAVES THE TRANSACTION ABORTED. That is a property of
// PostgreSQL rather than of this code: a statement that violates a constraint
// puts its transaction into 25P02, and every later statement in the same block
// fails until it ends. Catching the error converts the RESULT but does not undo
// the abort. It is safe for `registerNotificationRule`, whose unit of work
// contains this one statement and nothing else — PostgreSQL turns the COMMIT of
// an aborted transaction into a ROLLBACK, so no row survives — and it is pinned
// as a named case in `eventing-transaction.integration.test.ts` in BOTH halves:
// that the refusal is returned, and that nothing is committed. A caller that
// composed this insert with a later write would lose the later write, which is
// why the case exists rather than a comment saying it should not happen.
//
// `updateManyAndReturn` AND `deleteMany`, NEVER `update` OR `delete`. Both of
// the singular forms RAISE P2025 when nothing matched, and a raise inside the
// caller's transaction aborts it — so a rule addressed in the wrong scope would
// cost the caller its whole unit of work instead of returning the ordinary
// refusal the port describes. The plural forms answer with a count.
//
// `updatedAt` IS WRITTEN EXPLICITLY AND THAT IS DELIBERATE. The column is
// `@updatedAt`, so the client would stamp it on every update — and the DOMAIN
// already stamps it: `editNotificationRule(rule, edit, now)` sets it from the
// context's `Clock`. Letting the client win would put a value the domain
// computed under a value the adapter computed, and `updateNotificationRule`
// returns the domain's rule to its caller, so the two would disagree in the same
// breath.

import type {
  EnvironmentScope,
  NotificationRule,
  NotificationRuleId,
  Result,
  RuleName,
  TransactionScope,
} from "@platos/context-eventing/application/ports/index.js";
import { err, ok, ruleNameTaken, ruleNotFound } from "@platos/context-eventing/application/ports/index.js";

import type { TenancyJsonInput } from "./client.js";
import {
  guardNotificationRuleName,
  guardNotificationRuleWrite,
  guardScope,
  guardUuid,
} from "./eventing-guards.js";
import { isNameClash, refuse } from "./eventing-refusal.js";
import {
  NOTIFICATION_RULE_COLUMNS,
  readNotificationRule,
  scopedWhere,
  writeDestination,
  writeFilter,
  type NotificationRuleRow,
} from "./eventing-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The seven columns a full write binds, in the order the schema declares them.
 *
 * NAMED rather than `Record<string, unknown>`, and that is the compiler doing
 * work rather than a style: a widened record spread into `data` satisfies the
 * generated create input structurally and loses every required-field check, so a
 * column dropped from this function would have compiled and failed at runtime as
 * a NOT NULL violation inside somebody else's transaction.
 */
interface NotificationRuleWriteColumns {
  readonly name: string;
  readonly filters: TenancyJsonInput;
  readonly delivery: TenancyJsonInput;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function writeColumns(rule: NotificationRule): NotificationRuleWriteColumns {
  return {
    name: rule.name,
    filters: writeFilter(rule.filter) as TenancyJsonInput,
    delivery: writeDestination(rule.destination) as TenancyJsonInput,
    enabled: rule.enabled,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** The five methods that read or write one rule, plus the two listings. */
export function createNotificationRules(transactions: TenancyTransactions) {
  async function readOne(
    scope: EnvironmentScope,
    where: Record<string, unknown>,
  ): Promise<NotificationRule | null> {
    const row = await transactions.reader().notificationRule.findFirst({
      where: { ...scopedWhere(scope), ...where },
      select: NOTIFICATION_RULE_COLUMNS,
    });
    return row === null ? null : readNotificationRule(row as NotificationRuleRow, scope);
  }

  return {
    async insertRule(
      rule: NotificationRule,
      transaction: TransactionScope,
    ): Promise<Result<NotificationRule>> {
      return refuse(async () => {
        guardNotificationRuleWrite(rule);
        const client = transactions.writer(transaction);
        try {
          const row = await client.notificationRule.create({
            data: {
              id: rule.ruleId,
              environmentId: rule.scope.environmentId,
              ...writeColumns(rule),
            },
            select: NOTIFICATION_RULE_COLUMNS,
          });
          return ok(readNotificationRule(row as NotificationRuleRow, rule.scope));
        } catch (error) {
          if (!isNameClash(error)) throw error;
          return err(ruleNameTaken(rule.name));
        }
      }, "insertRule");
    },

    async updateRule(
      rule: NotificationRule,
      transaction: TransactionScope,
    ): Promise<Result<NotificationRule>> {
      return refuse(async () => {
        guardNotificationRuleWrite(rule);
        const client = transactions.writer(transaction);
        try {
          // The row is addressed by its id AND by the whole ancestry the rule
          // claims, so a rule object a caller synthesised with somebody else's
          // scope updates nothing rather than updating their row.
          const rows = await client.notificationRule.updateManyAndReturn({
            where: { id: rule.ruleId, ...scopedWhere(rule.scope) },
            data: writeColumns(rule),
            select: NOTIFICATION_RULE_COLUMNS,
          });
          const row = rows[0];
          if (row === undefined) return err(ruleNotFound(rule.ruleId));
          return ok(readNotificationRule(row as NotificationRuleRow, rule.scope));
        } catch (error) {
          if (!isNameClash(error)) throw error;
          return err(ruleNameTaken(rule.name));
        }
      }, "updateRule");
    },

    async deleteRule(
      scope: EnvironmentScope,
      ruleId: NotificationRuleId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuse(async () => {
        guardScope(scope);
        guardUuid("ruleId", ruleId);
        const { count } = await transactions.writer(transaction).notificationRule.deleteMany({
          where: { id: ruleId, ...scopedWhere(scope) },
        });
        return ok(count > 0);
      }, "deleteRule");
    },

    async findRule(
      scope: EnvironmentScope,
      ruleId: NotificationRuleId,
    ): Promise<Result<NotificationRule | null>> {
      return refuse(async () => {
        guardScope(scope);
        guardUuid("ruleId", ruleId);
        return ok(await readOne(scope, { id: ruleId }));
      }, "findRule");
    },

    async findRuleByName(
      scope: EnvironmentScope,
      name: RuleName,
    ): Promise<Result<NotificationRule | null>> {
      return refuse(async () => {
        guardScope(scope);
        // The name is a business key bound for a `TEXT` column, so the only
        // thing the database cannot hold is a NUL — and a lookup carrying one
        // would raise on the READ, inside whatever transaction is open.
        guardNotificationRuleName(name);
        return ok(await readOne(scope, { name }));
      }, "findRuleByName");
    },

    /**
     * Newest first, matching the legacy `orderBy: { createdAt: "desc" }`.
     *
     * THE ORDER IS NOT TOTAL AND THAT IS THE LEGACY'S SHAPE, PRESERVED.
     * `createdAt` is `timestamp(3)`, so two rules registered in the same
     * millisecond TIE and the database is free to return them either way round.
     * A tiebreak on `id` would make the order total — and would also make this
     * store disagree with `InMemoryNotificationRuleRepository`, whose own sort
     * leaves ties in insertion order, on a listing the conformance scenario
     * compares verbatim. The divergence is recorded rather than papered over:
     * the scenario registers rules at distinct instants, and nothing in this
     * context pages this listing, so a non-total order costs no row.
     */
    async listRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>> {
      return refuse(async () => {
        guardScope(scope);
        const rows = await transactions.reader().notificationRule.findMany({
          where: scopedWhere(scope),
          orderBy: { createdAt: "desc" },
          select: NOTIFICATION_RULE_COLUMNS,
        });
        return ok(rows.map((row) => readNotificationRule(row as NotificationRuleRow, scope)));
      }, "listRules");
    },

    /**
     * The routing read, narrowed to enabled rules IN THE STORE.
     *
     * That narrowing is the port's own instruction — "a routing pass over a busy
     * environment must not load every disabled rule to discard it in memory" —
     * and it is the legacy `where: { ...scope, enabled: true }` unchanged. No
     * `orderBy`, also unchanged: the legacy sends none, `route-observed-event.ts`
     * iterates the whole set, and adding one would be a statement this refactor
     * invented.
     */
    async listEnabledRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>> {
      return refuse(async () => {
        guardScope(scope);
        const rows = await transactions.reader().notificationRule.findMany({
          where: { ...scopedWhere(scope), enabled: true },
          select: NOTIFICATION_RULE_COLUMNS,
        });
        return ok(rows.map((row) => readNotificationRule(row as NotificationRuleRow, scope)));
      }, "listEnabledRules");
    },
  };
}
