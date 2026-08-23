import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(
    process.cwd(),
    "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx",
  ),
  "utf8",
);

describe("Provider visual projection", () => {
  it("renders safe metadata and guided credential operations without raw payload panels", () => {
    expect(source).toContain('credentialPanel("/api/v1/agent/providers"');
    expect(source).toContain("Provider readiness");
    expect(source).toContain("Credential route readiness");
    expect(source).toContain("Model catalogue");
    expect(source).toContain("Rate provenance");
    expect(source).toContain('<select required name="keyId"');
    expect(source).toContain('type="password"');
    expect(source).not.toContain("stableJson(fetcher.data)");
    expect(source).not.toContain("Available model catalogue</summary><pre");
  });

  it("gives the provider Link control explicit submit semantics", () => {
    expect(source).toMatch(/<fetcher\.Form method="post"[^>]*>[\s\S]*?<Button type="submit" name="intent" value=\{linked \? "unlink" : "link"\}/);
  });
});
