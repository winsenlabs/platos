import { Form } from "@remix-run/react";
import { asRecord, asString } from "../safe";
import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  PanelFailure,
  RevealOnceSecret,
  StatusChip,
  statusTone,
} from "../ProductPrimitives";

export type PanelResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: { code: string; message: string } };

export type SurfaceName =
  | "home" | "agents" | "agent-create" | "agent-config" | "context" | "agent-tools"
  | "versions" | "canary" | "conversations" | "thread" | "trace" | "tools"
  | "entities" | "entity-create" | "entity-secret" | "wire-test" | "mcp-platform" | "mcp-config"
  | "skills" | "postman" | "monitoring" | "monitoring-users" | "cost" | "budgets"
  | "governance" | "evals" | "audit" | "clusters" | "jobs" | "channels" | "accounts"
  | "files" | "files-users" | "files-conversations" | "files-attachments" | "memories"
  | "memory-graph" | "settings" | "variables";

export type SurfaceData = {
  surface: SurfaceName;
  title: string;
  description: string;
  panel: PanelResult;
  secondary?: PanelResult;
  supporting?: PanelResult;
  selection?: PanelResult;
  provenance?: string;
};

export type MutationData = {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string } | string;
};

export type SurfaceProps = {
  data: unknown;
  secondary?: unknown;
  supporting?: unknown;
  selection?: unknown;
  title: string;
};

export const fieldClass =
  "mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-sm text-text-bright";

export function Status({ value }: { value: unknown }) {
  const text = asString(value, "unknown");
  return <StatusChip tone={statusTone(text)}>{text}</StatusChip>;
}

export function MutationFeedback({ data }: { data: MutationData | undefined }) {
  if (!data) return null;
  if (!data.ok) {
    const error = typeof data.error === "string" ? data.error : asString(data.error?.message, "Mutation failed");
    return <div className="mb-5"><Alert tone="danger" title="Operation failed">{error}</Alert></div>;
  }
  const result = asRecord(data.result);
  const secret = asString(result.webhookUrl, asString(result.webhookPath, asString(result.serviceSecret, asString(result.webhookSecret, asString(result.plaintextSecret, "")))));
  return <div className="mb-5"><Alert tone="good">Mutation persisted through the canonical API.</Alert>{secret && <RevealOnceSecret value={secret} />}</div>;
}
