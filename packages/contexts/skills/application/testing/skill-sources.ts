// Skill sources for tests, built rather than pasted.
//
// A literal frontmatter block repeated across twenty tests is twenty places to
// update when the format moves, and it hides which field a given test actually
// cares about. `skillSource` takes the parts that matter and emits a valid
// document; a test that is about a MALFORMED document writes the malformed text
// out in full, because there the exact bytes are the subject.

export interface SkillSourceParts {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly category?: string;
  readonly requiredEnv?: readonly string[];
  readonly optionalEnv?: readonly string[];
  readonly tags?: readonly string[];
  readonly tools?: readonly { name: string; description?: string; handler?: string }[];
  readonly body?: string;
}

export function skillSource(parts: SkillSourceParts): string {
  const lines: string[] = ["---", `id: ${parts.id}`];
  lines.push(`name: ${parts.name ?? parts.id}`);
  lines.push(`description: ${parts.description ?? "a skill"}`);
  if (parts.version !== undefined) lines.push(`version: ${parts.version}`);
  if (parts.author !== undefined) lines.push(`author: ${parts.author}`);
  if (parts.category !== undefined) lines.push(`category: ${parts.category}`);
  for (const [field, values] of [
    ["required_env", parts.requiredEnv],
    ["optional_env", parts.optionalEnv],
    ["tags", parts.tags],
  ] as const) {
    if (values === undefined || values.length === 0) continue;
    lines.push(`${field}:`);
    for (const value of values) lines.push(`  - ${value}`);
  }
  if (parts.tools !== undefined && parts.tools.length > 0) {
    lines.push("provides_tools:");
    for (const tool of parts.tools) {
      lines.push(`  - name: ${tool.name}`);
      lines.push(`    description: ${tool.description ?? "a tool"}`);
      if (tool.handler !== undefined) lines.push(`    handler: ${tool.handler}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(parts.body ?? "Use this skill when it applies.");
  return lines.join("\n");
}
