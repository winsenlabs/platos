/**
 * Theme S — Official skill source blobs are the SEED source of truth.
 *
 * The seeder (OfficialSkillsSeederService) registers tools from the embedded
 * string constants in `official-skills.ts`, NOT from the sibling `.skill.md`
 * files. The two are kept in sync by hand, and they HAVE drifted before
 * (code_execution shipped run_shell + install_package + upload_to_sandbox in
 * the .md while the embedded constant still only declared run_python/run_node).
 *
 * These tests parse every embedded source through the real manifest parser so
 * a malformed blob or a missing tool can never reach the seeder again.
 */
import { describe, expect, it } from "vitest";
import { OFFICIAL_SKILL_SOURCES } from "./official-skills";
import { parseSkill } from "../skill-manifest.parser";

describe("OFFICIAL_SKILL_SOURCES", () => {
  it("every embedded official skill parses and declares its id", () => {
    for (const { id, source } of OFFICIAL_SKILL_SOURCES) {
      const parsed = parseSkill(source);
      expect(parsed.manifest.id, `${id} should parse`).toBe(id);
      expect(parsed.manifest.provides_tools.length, `${id} has tools`).toBeGreaterThan(0);
      // Every tool handler is namespaced under the skill id.
      for (const tool of parsed.manifest.provides_tools) {
        expect(tool.handler, `${id}.${tool.name} handler`).toBe(
          `skill:${id}:${tool.name}`,
        );
      }
    }
  });

  it("code_execution exposes the full persistent-sandbox toolset at v0.3.0", () => {
    const src = OFFICIAL_SKILL_SOURCES.find((s) => s.id === "platos.code_execution");
    expect(src).toBeDefined();
    const parsed = parseSkill(src!.source);
    expect(parsed.manifest.version).toBe("0.3.0");
    const toolNames = parsed.manifest.provides_tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(
      ["install_package", "run_node", "run_python", "run_shell", "upload_to_sandbox"].sort(),
    );
    expect(parsed.manifest.required_env).toContain("E2B_API_KEY");

    // run_shell schema requires `command` and caps timeout at 120s.
    const shell = parsed.manifest.provides_tools.find((t) => t.name === "run_shell");
    expect(shell?.inputSchema).toBeDefined();
    const schema = shell!.inputSchema as Record<string, any>;
    expect(schema.required).toContain("command");
    expect(schema.properties.timeoutMs.maximum).toBe(120000);
  });
});
