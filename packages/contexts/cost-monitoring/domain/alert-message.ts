// What an alert SAYS — the one rendering of a threshold crossing.
//
// The source renders the same facts three times: a plain-text body for email, an
// identical body for chat, and a JSON object for webhooks that repeats every
// field with its own spelling. Three renderings is three places for the number in
// the email and the number in the webhook to disagree, and the webhook is the one
// an operator's automation reads.
//
// So there is ONE payload here — the facts — and two renderings OF it. The
// renderings cannot disagree because neither computes anything.
//
// THE PAYLOAD CARRIES NO SECRET AND NO IDENTIFIER A RECIPIENT CANNOT ALREADY SEE.
// It names the environment it belongs to and the cap that fired, because a
// recipient wiring an automation needs to key on something stable, and it carries
// no credential reference, no channel configuration and no other tenant's data.
//
// AMOUNTS LEAVE AS CANONICAL DECIMAL STRINGS. A `Decimal(18, 6)` cent figure does
// not survive a JSON number: `0.686100` and the float nearest it are different
// values, and an automation summing a month of alerts would accumulate the
// difference.

import { moneyToMajorUnitString, type Money } from "@platos/kernel";

import type { BudgetPeriod } from "./window.js";
import type { BudgetSubject } from "./budget-scope.js";
import { spendToCentsString } from "./spend.js";
import type { BudgetId, ThresholdEventId, WindowKey } from "./identifiers.js";

/** Every fact an alert states. Nothing is derived downstream of here. */
export interface BudgetAlert {
  readonly eventId: ThresholdEventId;
  readonly budgetId: BudgetId;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly subject: BudgetSubject;
  readonly targetId: string;
  readonly subjectLabel: string;
  readonly period: BudgetPeriod;
  readonly threshold: number;
  readonly limitCents: number;
  readonly spent: Money;
  readonly tasks: number;
  readonly runsLimit: number;
  readonly windowKey: WindowKey;
  readonly firedAt: Date;
}

/**
 * The plain-text body. One sentence of what happened, then the numbers.
 *
 * The turn line is omitted when turns are uncapped, rather than printed as
 * "of 0" — a recipient reading "12 of 0" learns nothing and mistrusts the rest.
 */
export function renderAlertText(alert: BudgetAlert): string {
  const lines = [
    "Platos budget alert",
    "",
    `${alert.subjectLabel} crossed ${alert.threshold}% of its ${alert.period}ly cap.`,
    `Spent so far: ${moneyToMajorUnitString(alert.spent)} USD of ` +
      `${(alert.limitCents / 100).toFixed(2)} USD`,
  ];
  if (alert.runsLimit > 0) {
    lines.push(`Turns this window: ${alert.tasks} of ${alert.runsLimit}`);
  }
  lines.push(`Window: ${alert.windowKey}`);
  return lines.join("\n");
}

/** The subject line an email carries. */
export function renderAlertSubject(alert: BudgetAlert): string {
  return `Platos budget alert: ${alert.threshold}% threshold crossed`;
}

/** The structured body a webhook receives. Every amount is a string. */
export interface BudgetAlertDocument {
  readonly event: "platos.budget.threshold_crossed";
  readonly eventId: string;
  readonly budgetId: string;
  readonly scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
  };
  readonly subject: BudgetSubject;
  readonly targetId: string;
  readonly subjectLabel: string;
  readonly period: BudgetPeriod;
  readonly threshold: number;
  readonly limitCents: number;
  /** Canonical `Decimal(18, 6)` cents. Never a number. */
  readonly spentCents: string;
  readonly tasks: number;
  readonly runsLimit: number;
  readonly windowKey: string;
  readonly firedAt: string;
}

export function renderAlertDocument(alert: BudgetAlert): BudgetAlertDocument {
  return {
    event: "platos.budget.threshold_crossed",
    eventId: alert.eventId,
    budgetId: alert.budgetId,
    scope: {
      organizationId: alert.organizationId,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
    },
    subject: alert.subject,
    targetId: alert.targetId,
    subjectLabel: alert.subjectLabel,
    period: alert.period,
    threshold: alert.threshold,
    limitCents: alert.limitCents,
    spentCents: spendToCentsString(alert.spent),
    tasks: alert.tasks,
    runsLimit: alert.runsLimit,
    windowKey: alert.windowKey,
    firedAt: alert.firedAt.toISOString(),
  };
}
