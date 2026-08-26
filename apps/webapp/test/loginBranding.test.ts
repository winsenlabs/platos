import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operator login branding", () => {
  it("renders the canonical Platos logo from a committed public asset", () => {
    const route = readFileSync(resolve("app/routes/login._index/route.tsx"), "utf8");
    const logo = resolve("public/images/platos-logotype.png");

    expect(existsSync(logo)).toBe(true);
    expect(route).toContain('src="/images/platos-logotype.png"');
    expect(route).toContain('alt="Platos"');
  });
});
