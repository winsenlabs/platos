import assertNever from "assert-never";
import { z } from "zod";

export const ApiAlertType = z.enum([
  "run_failure",
  "deployment_failure",
  "deployment_success",
  "error_group",
]);
export type ApiAlertType = z.infer<typeof ApiAlertType>;

export const ApiAlertChannel = z.enum(["email", "webhook"]);
export type ApiAlertChannel = z.infer<typeof ApiAlertChannel>;

export const ApiAlertChannelData = z.object({
  email: z.string().optional(),
  url: z.string().optional(),
  hasSecret: z.boolean().optional(),
});
export type ApiAlertChannelData = z.infer<typeof ApiAlertChannelData>;

export const ApiCreateAlertChannel = z.object({
  environmentId: z.string().optional(),
  alertTypes: ApiAlertType.array(),
  name: z.string(),
  channel: ApiAlertChannel,
  channelData: z.object({
    email: z.string().optional(),
    url: z.string().optional(),
    secret: z.string().optional(),
  }),
  deduplicationKey: z.string().optional(),
});
export type ApiCreateAlertChannel = z.infer<typeof ApiCreateAlertChannel>;

export const ApiAlertChannelObject = z.object({
  id: z.string(),
  name: z.string(),
  alertTypes: ApiAlertType.array(),
  channel: ApiAlertChannel,
  channelData: ApiAlertChannelData,
  deduplicationKey: z.string().optional(),
});
export type ApiAlertChannelObject = z.infer<typeof ApiAlertChannelObject>;

type CanonicalAlertChannel = {
  id: string;
  name: string;
  type: "EMAIL" | "SLACK" | "WEBHOOK";
  alertTypes: string[];
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  configuration: Record<string, unknown> | null;
};

export class ApiAlertChannelPresenter {
  public static async alertChannelToApi(
    alertChannel: CanonicalAlertChannel
  ): Promise<ApiAlertChannelObject> {
    const configuration = alertChannel.configuration ?? {};
    return {
      id: alertChannel.id,
      name: alertChannel.name,
      alertTypes: alertChannel.alertTypes.map((type) => this.alertTypeToApi(type)),
      channel: this.alertChannelTypeToApi(alertChannel.type),
      channelData: alertChannel.type === "EMAIL"
        ? { email: typeof configuration.email === "string" ? configuration.email : undefined }
        : {
            url: typeof configuration.webhookUrl === "string" ? configuration.webhookUrl : undefined,
            hasSecret: typeof configuration.credentialId === "string",
          },
      deduplicationKey: alertChannel.userProvidedDeduplicationKey
        ? alertChannel.deduplicationKey ?? undefined
        : undefined,
    };
  }

  public static alertTypeToApi(alertType: string): ApiAlertType {
    switch (alertType) {
      case "TASK_RUN": return "run_failure";
      case "DEPLOYMENT_FAILURE": return "deployment_failure";
      case "DEPLOYMENT_SUCCESS": return "deployment_success";
      case "ERROR_GROUP": return "error_group";
      default: throw new Error(`Unsupported alert type: ${alertType}`);
    }
  }

  public static alertTypeFromApi(alertType: ApiAlertType): string {
    switch (alertType) {
      case "run_failure": return "TASK_RUN";
      case "deployment_failure": return "DEPLOYMENT_FAILURE";
      case "deployment_success": return "DEPLOYMENT_SUCCESS";
      case "error_group": return "ERROR_GROUP";
      default: assertNever(alertType);
    }
  }

  public static alertChannelTypeToApi(type: CanonicalAlertChannel["type"]): ApiAlertChannel {
    switch (type) {
      case "EMAIL": return "email";
      case "WEBHOOK": return "webhook";
      case "SLACK": throw new Error("Slack channels are not supported by this API");
      default: assertNever(type);
    }
  }
}
