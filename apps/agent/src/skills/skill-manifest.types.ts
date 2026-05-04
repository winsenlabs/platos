/**
 * Theme S — Skill manifest types (Claude-skills-format compatible).
 *
 * A skill is a markdown file with a YAML frontmatter header:
 *
 *     ---
 *     id: platos.web_search
 *     name: Web Search
 *     description: ...
 *     version: 0.1.0
 *     author: Platos
 *     required_env:
 *       - TAVILY_API_KEY
 *     optional_env:
 *       - EXA_API_KEY
 *     provides_tools:
 *       - name: web_search
 *         description: Search the public web.
 *         inputSchema:
 *           type: object
 *           properties:
 *             query: { type: string }
 *           required: [query]
 *     tags: [search, research]
 *     ---
 *
 *     You have access to a live web search tool. Use it when the user asks
 *     about recent events, current facts, or topics outside your training data.
 *
 * The body below the frontmatter is the prompt block that gets merged into
 * the agent's system prompt when the skill is enabled.
 *
 * Format invariants (PLATOS_SPEC §5 #7):
 *   - `id` MUST be namespaced (`org.skill_name`) to avoid collisions.
 *   - `required_env` is an array of env-var NAMES (secrets stay in
 *     trigger.dev's Environment Variables table; the skill never sees values).
 *   - `provides_tools[].inputSchema` is a JSON Schema object (draft-07-ish).
 *   - Every other field is optional; `name` defaults to the id on parse.
 */

export interface SkillProvidedTool {
  /** Tool name — namespaced by the skill id at registration time. */
  name: string;
  /** Human + LLM-facing description. */
  description: string;
  /** JSON Schema draft-07-ish for the tool input. Stored as-is. */
  inputSchema?: Record<string, unknown>;
  /** Optional output schema. */
  outputSchema?: Record<string, unknown>;
  /**
   * Implementation handler reference (optional). Either a trigger.dev task
   * identifier ("skill:platos.web_search:search") or a module path ("file:
   * ./tools/search.ts"). Used by the runtime to resolve the actual executor.
   */
  handler?: string;
}

export interface SkillManifest {
  /** Namespaced stable id, e.g. "platos.web_search". */
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  /** "official" | "community" | "custom" */
  origin?: string;
  required_env: string[];
  optional_env: string[];
  provides_tools: SkillProvidedTool[];
  tags: string[];
  /** Source URL (claude.ai skill library, github, etc.). */
  importedFrom?: string;
  /** Format spec version — pin to detect breaking changes. */
  spec_version?: string;
  /**
   * Theme TL.1 — category for grouping tools in the Tools tab + display
   * modes. Free-form string; if absent, downstream derives a fallback from
   * the slug (e.g. `web-search` → `web`). Stored verbatim from frontmatter
   * so a skill author can override the default grouping.
   */
  category?: string;
}

/** A fully-parsed skill file — manifest + prompt-block body. */
export interface ParsedSkill {
  manifest: SkillManifest;
  /** The markdown body below the frontmatter — spliced into the system prompt. */
  promptBlock: string;
  /** The raw skill source (for storage + re-parse round-trips). */
  source: string;
}

/** Thrown when a skill file cannot be parsed. */
export class SkillParseError extends Error {
  constructor(message: string, public readonly reason?: string) {
    super(message);
    this.name = "SkillParseError";
  }
}
