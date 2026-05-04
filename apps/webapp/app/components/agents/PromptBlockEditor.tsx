import { useState, useCallback, useEffect } from "react";
import {
  EyeIcon,
  EyeSlashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";

interface PromptBlock {
  id: string;
  type: string;
  name: string;
  content: string;
  enabled: boolean;
  editable: boolean;
  order: number;
}

interface PromptBlockEditorProps {
  blocks: PromptBlock[];
  onChange: (blocks: PromptBlock[]) => void;
}

/**
 * PromptBlockEditor — visual editor for system prompt blocks.
 *
 * Features:
 * - Toggle blocks on/off
 * - Reorder blocks (move up/down)
 * - Edit block content (inline textarea)
 * - Add custom blocks
 * - Template variable configuration
 * - Live preview of assembled prompt
 *
 * Guardrails block is always shown but not editable/disableable.
 */
// Live preview text for the datetime block — backend renders the same shape
// at assembly time via PromptBuilderService.renderDateTimeBlock. Kept in sync
// with that function; if you change the backend wording, change it here too.
function previewDateTimeBlock(): string {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const isoTime = now.toISOString().slice(11, 19);
  const utcDay = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = now.toLocaleDateString("en-CA", { timeZone: userTz });
  const localTime = now.toLocaleTimeString("en-GB", { timeZone: userTz, hour12: false });
  const localDay = now.toLocaleDateString("en-US", { weekday: "long", timeZone: userTz });
  return [
    `Current date: ${isoDate} (${utcDay}).`,
    `Current time: ${isoTime} UTC.`,
    `User timezone: ${userTz} — local time ${localDate} ${localTime} (${localDay}).`,
  ].join(" ");
}

// Renders an empty placeholder during SSR + first hydration, then swaps in the
// live timestamp string after mount. Otherwise React #418/#425 hydration
// errors fire because the server's UTC clock disagrees with the browser's
// local clock + timezone.
function DateTimeBlockPreview() {
  const [text, setText] = useState<string>("");
  useEffect(() => {
    setText(previewDateTimeBlock());
    const id = window.setInterval(() => setText(previewDateTimeBlock()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="text-xs font-mono text-emerald-300 min-h-[1rem]">
      {text || <span className="text-text-dimmed italic">Resolving…</span>}
    </div>
  );
}

export function PromptBlockEditor({ blocks, onChange }: PromptBlockEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewText, setPreviewText] = useState("");

  // Backfill a datetime block for legacy agents whose stored blocks predate
  // this feature. Disabled by default — the user explicitly opts in via the
  // toggle. Runs once per `blocks` shape change.
  useEffect(() => {
    if (blocks.some((b) => b.type === "datetime")) return;
    const guardrailsOrder = blocks.find((b) => b.type === "guardrails")?.order ?? 999;
    const datetimeBlock: PromptBlock = {
      id: "datetime",
      type: "datetime",
      name: "Current Date & Time",
      content: "",
      enabled: false,
      editable: true,
      order: Math.max(0, guardrailsOrder - 1),
    };
    onChange([...blocks, datetimeBlock]);
  }, [blocks, onChange]);

  // Assemble preview whenever blocks change
  useEffect(() => {
    const enabledBlocks = blocks.filter((b) => b.enabled).sort((a, b) => a.order - b.order);
    const parts = enabledBlocks
      .map((b) => {
        if (b.type === "identity") return b.content;
        // Cache-correctness fix: do NOT include the datetime preview text in
        // the saved `systemPrompt` string. The agent runtime injects a fresh
        // timestamp into the dynamic-context (post-cache-breakpoint) at every
        // turn, so the saved prompt stays cache-stable across days while the
        // LLM still sees the current date/time. If we render the timestamp
        // into the saved string, every save (and any per-turn re-render via
        // assembleAsync) writes a different cache key and Anthropic's prompt
        // cache invalidates on every turn — exactly the bug we're fixing.
        if (b.type === "datetime") return null;
        return `## ${b.name}\n\n${b.content}`;
      })
      .filter((p): p is string => p !== null);
    setPreviewText(parts.join("\n\n"));
  }, [blocks]);

  const toggleBlock = useCallback((id: string) => {
    const block = blocks.find((b) => b.id === id);
    if (!block || !block.editable) return; // Can't toggle non-editable blocks (guardrails)
    onChange(blocks.map((b) => b.id === id ? { ...b, enabled: !b.enabled } : b));
  }, [blocks, onChange]);

  const moveBlock = useCallback((id: string, direction: "up" | "down") => {
    const sorted = [...blocks].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const temp = sorted[idx].order;
    sorted[idx].order = sorted[swapIdx].order;
    sorted[swapIdx].order = temp;
    onChange([...sorted]);
  }, [blocks, onChange]);

  const updateContent = useCallback((id: string, content: string) => {
    onChange(blocks.map((b) => b.id === id ? { ...b, content } : b));
  }, [blocks, onChange]);

  const addCustomBlock = useCallback(() => {
    const maxOrder = Math.max(...blocks.filter((b) => b.type !== "guardrails").map((b) => b.order), 0);
    const newBlock: PromptBlock = {
      id: `custom-${Date.now()}`,
      type: "custom",
      name: "Custom Block",
      content: "",
      enabled: true,
      editable: true,
      order: maxOrder + 1,
    };
    onChange([...blocks, newBlock]);
  }, [blocks, onChange]);

  const removeBlock = useCallback((id: string) => {
    const block = blocks.find((b) => b.id === id);
    if (!block || block.type !== "custom") return; // Can only remove custom blocks
    onChange(blocks.filter((b) => b.id !== id));
  }, [blocks, onChange]);

  const updateBlockName = useCallback((id: string, name: string) => {
    onChange(blocks.map((b) => b.id === id ? { ...b, name } : b));
  }, [blocks, onChange]);

  const sortedBlocks = [...blocks].sort((a, b) => a.order - b.order);
  const enabledCount = blocks.filter((b) => b.enabled).length;
  const estimatedTokens = Math.ceil(previewText.length / 4);

  return (
    <div className="space-y-4">
      {/* Header with stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Header3>System Prompt Blocks</Header3>
          <Badge variant="outline-rounded">{enabledCount}/{blocks.length} enabled</Badge>
          <Badge variant="outline-rounded">~{estimatedTokens} tokens</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="tertiary/small" onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? <EyeSlashIcon className="size-4 mr-1" /> : <EyeIcon className="size-4 mr-1" />}
            {showPreview ? "Hide Preview" : "Show Preview"}
          </Button>
          <Button variant="tertiary/small" onClick={addCustomBlock}>
            <PlusIcon className="size-4 mr-1" />
            Add Block
          </Button>
        </div>
      </div>

      <div className={showPreview ? "grid grid-cols-2 gap-4" : ""}>
        {/* Block list */}
        <div className="space-y-2">
          {sortedBlocks.map((block, idx) => (
            <div
              key={block.id}
              className={`rounded-lg border ${
                block.enabled
                  ? "border-charcoal-600 bg-charcoal-800"
                  : "border-charcoal-700 bg-charcoal-850 opacity-60"
              } overflow-hidden`}
            >
              {/* Block header */}
              <div className="flex items-center justify-between px-3 py-2 bg-charcoal-750">
                <div className="flex items-center gap-2">
                  {/* Toggle */}
                  <button
                    onClick={() => toggleBlock(block.id)}
                    disabled={!block.editable}
                    className={`w-8 h-4 rounded-full transition-colors ${
                      block.enabled ? "bg-emerald-500" : "bg-charcoal-600"
                    } ${!block.editable ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    title={block.editable ? "Toggle block" : "Cannot disable guardrails"}
                  >
                    <div className={`w-3 h-3 rounded-full bg-white transition-transform ${
                      block.enabled ? "translate-x-4.5 ml-[18px]" : "translate-x-0.5 ml-[2px]"
                    }`} />
                  </button>
                  {/* Name */}
                  {block.type === "custom" ? (
                    <input
                      value={block.name}
                      onChange={(e) => updateBlockName(block.id, e.target.value)}
                      className="text-xs font-semibold text-text-bright bg-transparent border-b border-charcoal-600 focus:border-emerald-500 focus:outline-none px-1"
                    />
                  ) : (
                    <span className="text-xs font-semibold text-text-bright">{block.name}</span>
                  )}
                  <Badge variant="outline-rounded" className="text-[10px]">{block.type}</Badge>
                  {!block.editable && (
                    <Badge variant="outline-rounded" className="text-[10px] text-amber-400">locked</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {/* Move up/down */}
                  <button
                    onClick={() => moveBlock(block.id, "up")}
                    disabled={idx === 0}
                    className="p-1 rounded hover:bg-charcoal-600 disabled:opacity-20"
                  >
                    <ChevronUpIcon className="size-3.5 text-text-dimmed" />
                  </button>
                  <button
                    onClick={() => moveBlock(block.id, "down")}
                    disabled={idx === sortedBlocks.length - 1 || sortedBlocks[idx + 1]?.type === "guardrails"}
                    className="p-1 rounded hover:bg-charcoal-600 disabled:opacity-20"
                  >
                    <ChevronDownIcon className="size-3.5 text-text-dimmed" />
                  </button>
                  {/* Delete (custom only) */}
                  {block.type === "custom" && (
                    <button onClick={() => removeBlock(block.id)} className="p-1 rounded hover:bg-red-600/20">
                      <TrashIcon className="size-3.5 text-red-400" />
                    </button>
                  )}
                </div>
              </div>
              {/* Block content */}
              {block.enabled && block.type === "datetime" && (
                <div className="px-3 py-2 space-y-1">
                  <div className="text-[11px] text-text-dimmed">
                    Auto-injected on every turn. Lands in the dynamic (non-cached) section
                    so timestamps stay fresh without invalidating the prompt cache.
                  </div>
                  {/* Client-only — server-rendered string would hydration-mismatch */}
                  {/* against the client's locale + timezone. Render a placeholder for SSR. */}
                  <DateTimeBlockPreview />
                </div>
              )}
              {block.enabled && block.type !== "datetime" && (
                <div className="px-3 py-2">
                  <textarea
                    value={block.content}
                    onChange={(e) => updateContent(block.id, e.target.value)}
                    disabled={!block.editable}
                    rows={Math.max(3, block.content.split("\n").length)}
                    className={`w-full text-xs font-mono bg-transparent text-text-bright resize-y focus:outline-none ${
                      !block.editable ? "opacity-70 cursor-not-allowed" : ""
                    }`}
                    placeholder="Block content..."
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Preview panel */}
        {showPreview && (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 overflow-hidden">
            <div className="px-3 py-2 bg-charcoal-750 border-b border-charcoal-700">
              <span className="text-xs font-semibold text-text-bright">Assembled Preview</span>
              <span className="text-xs text-text-dimmed ml-2">{previewText.length} chars</span>
            </div>
            <pre className="px-3 py-2 text-xs text-text-bright whitespace-pre-wrap max-h-[600px] overflow-y-auto">
              {previewText || "(empty — enable some blocks)"}
            </pre>
          </div>
        )}
      </div>

      {/* Hidden inputs for form submission */}
      <input type="hidden" name="systemPrompt" value={previewText} />
      <input type="hidden" name="systemPromptBlocks" value={JSON.stringify(blocks)} />
    </div>
  );
}
