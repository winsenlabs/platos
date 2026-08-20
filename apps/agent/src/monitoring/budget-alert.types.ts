export interface BudgetAlertPayload {
  eventId: string;
  capId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  scopeType: "scope" | "agent" | "user";
  targetId: string;
  period: "day" | "week" | "month";
  threshold: number;
  limitCents: number;
  spentCents: number;
  runs: number;
  runsLimit: number;
  windowKey: string;
  /** Retained for wire compatibility; canonical recipients come from AlertDelivery. */
  alertWebhookUrl?: string | null;
  /** Retained for wire compatibility; canonical recipients come from AlertDelivery. */
  alertEmails?: string | null;
  subjectLabel: string;
}

export interface BudgetAlertDeliverySummary {
  delivered: number;
  failed: number;
  skipped: number;
  attempts: Array<{
    deliveryId: string;
    channelId: string;
    type: string;
    status: "SUCCEEDED" | "FAILED" | "SKIPPED";
    statusCode: number | null;
    errorCode: string | null;
  }>;
}
