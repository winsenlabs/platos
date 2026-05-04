/**
 * Theme F.9 — artifact side panel.
 *
 * Listens to `artifact_start` / `artifact_delta` / `artifact_committed` /
 * `artifact_error` stream events (F.7) and renders each artifact via
 * `<PlatosArtifact>` (F.8 — webapp-local copy to avoid cross-workspace dep).
 *
 * The panel is keyboard-toggleable (Escape closes when open); the toggle
 * button has `aria-expanded` wired to the open state so screen readers
 * announce the drawer state correctly. Artifact history lives in a flat
 * list ordered newest-first.
 *
 * This component is UI-only. The page that owns the chat socket hands in
 * both the seeded history (via `initialArtifacts`, loader-fetched) and the
 * live-event stream state (via `liveArtifacts`). Merging is done here so
 * the parent doesn't duplicate the keyed-by-`artifactKey` reducer.
 */
import { ArchiveBoxIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import {
  PlatosArtifact,
  type PlatosArtifactData,
  type PlatosArtifactKind,
} from "./PlatosArtifact";

export interface ThreadArtifact {
  id: string;
  artifactKey: string;
  revision: number;
  kind: PlatosArtifactKind | string;
  title: string | null;
  language: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  revisionCount?: number;
  /** Populated on live-streamed partials before the commit lands. */
  streaming?: boolean;
  /** Populated when an artifact_error event fires for this artifact. */
  error?: string;
}

export interface ArtifactPanelProps {
  open: boolean;
  onClose: () => void;
  artifacts: ThreadArtifact[];
}

export function ArtifactPanel({ open, onClose, artifacts }: ArtifactPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Escape closes the panel for keyboard users. Only attach while open so
  // we don't fight page-level shortcuts when the drawer is hidden.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sorted = useMemo(
    () =>
      [...artifacts].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [artifacts],
  );

  const expanded = sorted.find((a) => a.id === expandedId) ?? null;

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label="Thread artifacts panel"
      className="flex w-[420px] flex-col border-l border-charcoal-700 bg-charcoal-850"
    >
      <header className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2">
        <div className="flex items-center gap-2 text-text-bright">
          <ArchiveBoxIcon className="size-4 text-emerald-400" />
          <span className="text-sm font-medium">Artifacts</span>
          <span className="text-xs text-text-dimmed">({sorted.length})</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close artifacts panel"
          className="rounded p-1 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
        >
          <XMarkIcon className="size-4" />
        </button>
      </header>

      {expanded ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-1.5 text-xs">
            <button
              type="button"
              onClick={() => setExpandedId(null)}
              aria-label="Back to artifact list"
              className="text-text-dimmed hover:text-text-bright"
            >
              ← Back
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(expanded.content).catch(() => {});
                }}
                aria-label="Copy artifact content"
                className="rounded border border-charcoal-700 bg-charcoal-800 px-2 py-0.5 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
              >
                Copy
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <PlatosArtifact artifact={toRendererProps(expanded)} />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {sorted.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-dimmed">
              No artifacts yet. The agent will emit them via
              <code className="mx-1">generate_artifact</code>.
            </div>
          ) : (
            sorted.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => setExpandedId(a.id)}
                aria-label={`Open artifact ${a.title ?? a.kind} revision ${a.revision}`}
                className="w-full text-left rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 hover:border-emerald-600/50 hover:bg-charcoal-750 transition"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-text-bright">
                    {a.title || defaultTitleFor(a.kind)}
                  </span>
                  <span className="shrink-0 rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-dimmed">
                    {a.kind}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-text-dimmed">
                  <span>rev {a.revision}</span>
                  {typeof a.revisionCount === "number" && a.revisionCount > 1 ? (
                    <span>· {a.revisionCount} revisions</span>
                  ) : null}
                  {a.streaming ? (
                    <span className="text-amber-400">· streaming…</span>
                  ) : null}
                  {a.error ? <span className="text-rose-400">· {a.error}</span> : null}
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] text-text-dimmed">
                  {previewFor(a)}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function toRendererProps(a: ThreadArtifact): PlatosArtifactData {
  return {
    id: a.id,
    artifactKey: a.artifactKey,
    type: a.kind,
    content: a.content,
    title: a.title ?? undefined,
    revision: a.revision,
    metadata: {
      ...(a.metadata ?? {}),
      ...(a.language ? { language: a.language } : {}),
    },
  };
}

function defaultTitleFor(kind: string): string {
  const map: Record<string, string> = {
    markdown: "Markdown",
    code: "Code",
    html: "HTML",
    json: "JSON",
    csv: "CSV",
    svg: "SVG",
    image: "Image",
  };
  return map[kind] ?? "Artifact";
}

function previewFor(a: ThreadArtifact): string {
  // Images + HTML are opaque in a text preview — show the kind label instead
  // so the list doesn't render garbage base64 or raw HTML.
  if (a.kind === "image") return "image preview";
  if (a.kind === "html") return "html preview";
  const first = a.content.split("\n")[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}
