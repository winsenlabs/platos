/**
 * Shared dynamic-blocks editor.
 *
 * Dynamic blocks are per-turn content injected into a `<context>` wrapper in the
 * USER message (not the system prompt), so they're never cached and can safely
 * carry session-specific data (current screen, user state, live metrics).
 *
 * This is a controlled component: it takes `blocks` + `onChange` and renders the
 * full editor (key / name / content template / description per block) plus a live
 * preview of what the LLM sees. It is used in BOTH the agent-creation wizard and
 * the agent Context tab so the two surfaces can never drift.
 */

import { CubeTransparentIcon, PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";

export type DynamicBlock = {
  key: string;
  name: string;
  defaultContent: string;
  description?: string;
};

interface Props {
  blocks: DynamicBlock[];
  onChange: (blocks: DynamicBlock[]) => void;
  /** Hide the explanatory copy (the wizard step already frames it). */
  hideIntro?: boolean;
}

function PreviewPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-charcoal-700 bg-charcoal-900 p-3 text-[11px] font-mono text-text-dimmed">
      {children}
    </div>
  );
}

export function DynamicBlocksEditor({ blocks, onChange, hideIntro }: Props) {
  const addBlock = () => onChange([...blocks, { key: "", name: "", defaultContent: "", description: "" }]);
  const updateBlock = (i: number, field: keyof DynamicBlock, value: string) =>
    onChange(blocks.map((b, idx) => (idx === i ? { ...b, [field]: value } : b)));
  const removeBlock = (i: number) => onChange(blocks.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-4">
      {!hideIntro && (
        <>
          <Paragraph variant="small">
            Dynamic blocks are <strong>per-turn content</strong> injected into a{" "}
            <code className="font-mono text-emerald-400">{"<context>"}</code> wrapper in the user
            message — NOT the system prompt. This means they are <strong>never cached</strong> by
            Anthropic and can safely contain session-specific data (current screen, user state,
            live metrics). Keep the system prompt fully static for maximum cache efficiency;
            put anything that changes per-turn here.
          </Paragraph>
          <Paragraph variant="small">
            Each block has a <strong>key</strong> (how your backend addresses it),{" "}
            a <strong>name</strong> (the heading the LLM sees), and a{" "}
            <strong>content template</strong> that can reference{" "}
            <code className="font-mono text-amber-300">{"{{session.context.keys}}"}</code>.
          </Paragraph>
        </>
      )}

      <div className="space-y-3">
        {blocks.length === 0 && (
          <div className="rounded border border-dashed border-charcoal-600 px-4 py-6 text-center text-sm text-text-dimmed">
            No dynamic blocks yet. Add one below.
          </div>
        )}
        {blocks.map((block, i) => (
          <div key={i} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <CubeTransparentIcon className="size-4 text-emerald-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-text-dimmed uppercase tracking-wider block mb-1">Key (machine ID)</label>
                  <input
                    value={block.key}
                    onChange={(e) => updateBlock(i, "key", e.target.value)}
                    placeholder="e.g. screen_context"
                    className="w-full rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-xs text-text-bright font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-text-dimmed uppercase tracking-wider block mb-1">Name (LLM heading)</label>
                  <input
                    value={block.name}
                    onChange={(e) => updateBlock(i, "name", e.target.value)}
                    placeholder="e.g. Current Screen"
                    className="w-full rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-xs text-text-bright"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeBlock(i)}
                className="text-text-dimmed hover:text-rose-400 flex-shrink-0"
              >
                <TrashIcon className="size-4" />
              </button>
            </div>
            <div>
              <label className="text-[10px] text-text-dimmed uppercase tracking-wider block mb-1">
                Content template{" "}
                <span className="normal-case text-text-dimmed font-normal">— use <code className="font-mono text-amber-300">{"{{key}}"}</code> for sessionContext values</span>
              </label>
              <textarea
                value={block.defaultContent}
                onChange={(e) => updateBlock(i, "defaultContent", e.target.value)}
                rows={3}
                placeholder={`e.g. The user is currently on the {{screen.page}} page.\nLast action: {{screen.last_action}}`}
                spellCheck={false}
                className="w-full rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-xs text-text-bright font-mono resize-y"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-dimmed uppercase tracking-wider block mb-1">Description (optional)</label>
              <input
                value={block.description ?? ""}
                onChange={(e) => updateBlock(i, "description", e.target.value)}
                placeholder="What this block provides to the agent"
                className="w-full rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-xs text-text-dimmed"
              />
            </div>
          </div>
        ))}

        <Button type="button" variant="tertiary/small" LeadingIcon={PlusIcon} onClick={addBlock}>
          Add block
        </Button>
      </div>

      {/* Preview of what the LLM sees */}
      {blocks.some((b) => b.key && b.name) && (
        <div className="space-y-1">
          <p className="text-[10px] text-text-dimmed uppercase tracking-wider">What the LLM sees each turn</p>
          <PreviewPane>
            <p className="text-text-dimmed">{"<context>"}</p>
            {blocks.filter((b) => b.key && b.name).map((b) => (
              <div key={b.key} className="ml-2 mt-1">
                <p className="text-emerald-300">## {b.name}</p>
                <p className="text-text-bright whitespace-pre-wrap">{b.defaultContent || "(content from sessionContext)"}</p>
              </div>
            ))}
            <p className="text-text-dimmed mt-1">{"</context>"}</p>
          </PreviewPane>
        </div>
      )}
    </div>
  );
}
