import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(
    process.cwd(),
    "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx",
  ),
  "utf8",
);

describe("Playground visual projection", () => {
  it("keeps the real Turn transports while making transcript diagnostics primary", () => {
    expect(source).toContain("/chat/stream?");
    expect(source).toContain('intent === "collect"');
    expect(source).toContain("abortRef.current?.abort()");
    expect(source).toContain("safeMessageId(body.messageId)");
    expect(source).toContain("function ReasoningBlock");
    expect(source).toContain("function ToolCallCard");
    expect(source).toContain('label: "Assembly"');
    expect(source).toContain('label: "Tools"');
    expect(source).toContain('label: "Memory"');
    expect(source).toContain('label: "Raw"');
    expect(source).not.toContain("setAnswer(stableJson(payload))");
  });
});
