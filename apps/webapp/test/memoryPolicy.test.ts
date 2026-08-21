import { describe, expect, it } from "vitest";
import {
  BUILD_HEADROOM_MB,
  MIB,
  buildMemoryPolicy,
  cgroupV2Paths,
  parsePositiveInteger,
  runtimeMemoryPolicy,
  withHeapOption,
} from "../scripts/memory-policy.mjs";
import { hasFatalBuildDiagnostic, remixBuildArgs } from "../scripts/build-remix.mjs";

describe("webapp memory policy", () => {
  it("refuses a build on a host with only about 3 GiB available", () => {
    const policy = buildMemoryPolicy({ availableBytes: 3 * 1024 * MIB });
    expect(policy.ok).toBe(false);
    expect(policy.requiredMb).toBe(1536 + BUILD_HEADROOM_MB);
    expect(policy.message).toContain("Build off-box");
  });

  it("allows the conservative build heap only with additional headroom", () => {
    expect(buildMemoryPolicy({ availableBytes: (1536 + BUILD_HEADROOM_MB) * MIB })).toMatchObject({
      ok: true,
      heapMb: 1536,
    });
  });

  it("keeps the default runtime heap safely below a 2 GiB container limit", () => {
    expect(runtimeMemoryPolicy({ limitBytes: 2048 * MIB })).toMatchObject({
      ok: true,
      heapMb: 1536,
      maximumHeapMb: 1536,
    });
  });

  it("rejects a runtime heap that leaves too little container headroom", () => {
    const policy = runtimeMemoryPolicy({ limitBytes: 2048 * MIB, heapMb: 1792 });
    expect(policy.ok).toBe(false);
    expect(policy.message).toContain("runtime refused");
  });

  it("replaces inherited heap flags instead of allowing a larger hidden value", () => {
    expect(withHeapOption("--trace-warnings --max-old-space-size=8192", 1536)).toBe(
      "--max-old-space-size=1536 --trace-warnings",
    );
  });

  it("rejects malformed configurable heap values", () => {
    expect(() => parsePositiveInteger("HEAP", "1.5", 1536)).toThrow(
      "HEAP must be a positive integer",
    );
  });

  it("keeps high-memory production source maps explicit and off by default", () => {
    expect(remixBuildArgs({})).toEqual(["remix", "build"]);
    expect(remixBuildArgs({ WEBAPP_BUILD_SOURCEMAPS: "true" })).toEqual([
      "remix",
      "build",
      "--sourcemap",
    ]);
  });

  it("rejects esbuild fatal diagnostics even when the child exits zero", () => {
    expect(hasFatalBuildDiagnostic("built\nfatal error: all goroutines are asleep - deadlock!\n")).toBe(true);
    expect(hasFatalBuildDiagnostic("built successfully\n")).toBe(false);
  });

  it("resolves nested cgroup v2 controller paths from /proc/self/cgroup", () => {
    expect(cgroupV2Paths("0::/system.slice/platos.service/webapp\n")).toEqual({
      limit: "/sys/fs/cgroup/system.slice/platos.service/webapp/memory.max",
      current: "/sys/fs/cgroup/system.slice/platos.service/webapp/memory.current",
    });
  });
});
