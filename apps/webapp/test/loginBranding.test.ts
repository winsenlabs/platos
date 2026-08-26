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
    expect(route).toContain("width={320}");
    expect(route).toContain("height={156}");
    expect(route).toContain("The only runtime");
    expect(route).toContain("you will ever need");
    expect(route).toContain("lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]");
    expect(route).toContain("Continue with email");
  });
});
