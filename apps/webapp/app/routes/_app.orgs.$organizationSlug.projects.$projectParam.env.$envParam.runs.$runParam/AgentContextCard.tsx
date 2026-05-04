/**
 * K.1 — Agent context card.
 *
 * Compact summary rendered at the top of the run detail page when a run was
 * spawned by the Platos agent runtime (detected via `run.metadata.agentId`).
 * Purely presentational — the loader does the Prisma lookups (scope-gated
 * with the full tuple) and hands us either:
 *
 *   - `{ agent, thread }` — both lookups succeeded.
 *   - `{ agent: null, thread: null }` — metadata said it was an agent run but
 *     one or both rows weren't reachable from the current scope. Render a
 *     "not found in this scope" fallback so the whole page still shows.
 *
 * Co-exists with the W.3 BatchRunView: route.tsx renders this card above
 * BatchRunView for `platos-agent-batch` runs and above the trace view for
 * every other agent-runtime run.
 */
import { BookOpenIcon, ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { useMemo, useState } from "react";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import {
  agentConversationPath,
  agentPath,
} from "~/utils/pathBuilder";

const SESSION_CONTEXT_KEY_LIMIT = 5;
const SESSION_CONTEXT_VALUE_PREVIEW_CHARS = 60;

export type AgentContextCardAgent = {
  id: string;
  name: string;
  slug: string;
  model: string;
};

export type AgentContextCardThread = {
  id: string;
  title: string | null;
  turnCount: number;
  /** Loader serialises Prisma JSON as an opaque value — we narrow here. */
  sessionContext: unknown;
};

export type AgentContextCardProps = {
  agent: AgentContextCardAgent | null;
  thread: AgentContextCardThread | null;
  /** From metadata when we couldn't find the row — lets us still show the id. */
  missingAgentId: string | null;
  missingThreadId: string | null;
  /** Run-level cost (displayed alongside the thread turn count). */
  costInCents: number;
  organization: { slug: string };
  project: { slug: string };
  environment: { slug: string };
};

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.length > SESSION_CONTEXT_VALUE_PREVIEW_CHARS
      ? `"${value.slice(0, SESSION_CONTEXT_VALUE_PREVIEW_CHARS)}…"`
      : `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Objects / arrays — stringify and truncate.
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > SESSION_CONTEXT_VALUE_PREVIEW_CHARS
      ? `${json.slice(0, SESSION_CONTEXT_VALUE_PREVIEW_CHARS)}…`
      : json;
  } catch {
    return String(value);
  }
}

function SessionContextPreview({ sessionContext }: { sessionContext: unknown }) {
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo<Array<[string, unknown]>>(() => {
    if (!sessionContext || typeof sessionContext !== "object" || Array.isArray(sessionContext)) {
      return [];
    }
    return Object.entries(sessionContext as Record<string, unknown>);
  }, [sessionContext]);

  if (entries.length === 0) {
    return (
      <Paragraph variant="extra-small" className="text-text-dimmed">
        No session context set.
      </Paragraph>
    );
  }

  const visible = expanded ? entries : entries.slice(0, SESSION_CONTEXT_KEY_LIMIT);
  const hiddenCount = entries.length - visible.length;

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {visible.map(([key, value]) => (
          <li
            key={key}
            className="flex gap-1.5 font-mono text-xxs text-text-dimmed"
          >
            <span className="text-text-bright">{key}:</span>
            <span className="truncate">{previewValue(value)}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 || expanded ? (
        <button
          type="button"
          className="self-start text-xxs text-blue-500 hover:text-blue-400"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </button>
      ) : null}
    </div>
  );
}

export function AgentContextCard({
  agent,
  thread,
  missingAgentId,
  missingThreadId,
  costInCents,
  organization,
  project,
  environment,
}: AgentContextCardProps) {
  // Fallback — metadata flagged this as an agent run but the row(s) aren't
  // reachable from the current scope (deleted, moved envs, or cross-scope
  // impersonation tightening).
  if (!agent || !thread) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-charcoal-700 bg-background-bright px-4 py-3">
        <div className="flex items-center gap-2">
          <Header3>Agent context</Header3>
          <Badge variant="small">Not in scope</Badge>
        </div>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          Agent/thread not found in this scope
          {missingAgentId ? ` (agentId: ${missingAgentId})` : ""}
          {missingThreadId ? ` (threadId: ${missingThreadId})` : ""}
          .
        </Paragraph>
      </div>
    );
  }

  const costDollars = (costInCents ?? 0) / 100;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-background-bright px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Header3>Agent context</Header3>
          <Badge variant="small">{agent.model}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton
            variant="tertiary/small"
            LeadingIcon={BookOpenIcon}
            to={agentPath(organization, project, environment, agent.id)}
          >
            Open agent
          </LinkButton>
          <LinkButton
            variant="tertiary/small"
            LeadingIcon={ChatBubbleLeftRightIcon}
            to={agentConversationPath(
              organization,
              project,
              environment,
              agent.id,
              thread.id
            )}
          >
            View thread
          </LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Field label="Agent">
          <span className="text-sm text-text-bright">{agent.name}</span>
          <span className="font-mono text-xxs text-text-dimmed">{agent.slug}</span>
        </Field>
        <Field label="Thread">
          <span className="truncate text-sm text-text-bright">
            {thread.title ?? "(untitled)"}
          </span>
          <span className="font-mono text-xxs text-text-dimmed">{thread.id}</span>
        </Field>
        <Field label="Turns">
          <span className="text-sm text-text-bright">{thread.turnCount}</span>
        </Field>
        <Field label="Run cost">
          <span className="text-sm text-text-bright">
            {costInCents > 0 ? formatCurrencyAccurate(costDollars) : "—"}
          </span>
        </Field>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xxs uppercase tracking-wider text-text-dimmed">
          Session context
        </span>
        <SessionContextPreview sessionContext={thread.sessionContext} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xxs uppercase tracking-wider text-text-dimmed">{label}</span>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
