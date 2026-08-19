/**
 * Alert-channel persistence belongs to the paused WIN-124 cutover. Keep the
 * registered MCP surface stable, but fail before reading or writing legacy
 * ProjectAlertChannel / OrganizationIntegration rows or handling secrets.
 */

import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { McpToolHandler } from "../mcp-router";

function alertChannelsUnavailable() {
  return {
    error: "unavailable",
    message:
      "Alert channel management is unavailable pending the canonical WIN-124 persistence cutover.",
  } as const;
}

export function buildAlertChannelToolHandlers(_deps: {
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  return [
    {
      name: "alert_channels.list",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["EMAIL", "SLACK", "WEBHOOK"] },
          enabled: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
    {
      name: "alert_channels.create",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        required: ["type", "name", "alertTypes", "channel"],
        properties: {
          type: { type: "string", enum: ["EMAIL", "SLACK", "WEBHOOK"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: { type: "array", minItems: 1, items: { type: "string" } },
          environmentTypes: { type: "array", items: { type: "string" } },
          deduplicationKey: { type: "string", maxLength: 200 },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
    {
      name: "alert_channels.update",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: { type: "array", items: { type: "string" } },
          environmentTypes: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
    {
      name: "alert_channels.delete",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
    {
      name: "alert_channels.test",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          message: { type: "string", maxLength: 500 },
        },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
    {
      name: "alert_channels.get_integration",
      description:
        "Alert channel management is unavailable pending the canonical " +
        "WIN-124 persistence cutover.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute() {
        return alertChannelsUnavailable();
      },
    },
  ];
}
