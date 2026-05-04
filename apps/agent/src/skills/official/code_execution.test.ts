/**
 * PRA-CE: Code Execution skill handler tests.
 *
 * Tests runCode / installPackage handler logic without real E2B network calls.
 * Verifies: successful execution, error propagation, missing API key guard,
 * empty code guard, timeout clamp, sandbox.kill() always called, package
 * name validation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockKill = vi.fn().mockResolvedValue(undefined);
const mockRunCode = vi.fn();
const mockSandboxCreate = vi.fn();

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: { create: mockSandboxCreate },
}));

function makeScopedEnv(keys: Record<string, string | null>) {
  return { get: vi.fn().mockImplementation((_scope: unknown, key: string) => Promise.resolve(keys[key] ?? null)) };
}

async function makeHandler(envKeys: Record<string, string | null> = { E2B_API_KEY: "test-key" }) {
  const { OfficialSkillHandlers } = await import("./skill-handlers");
  const scopedEnv = makeScopedEnv(envKeys);
  // @ts-expect-error — partial constructor for unit testing
  return new OfficialSkillHandlers(scopedEnv, undefined, undefined);
}

const SCOPE = { organizationId: "org1", projectId: "proj1", environmentId: "env1", userId: "user1" };

describe("platos.code_execution — run_python / run_node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });
  });

  it("returns stdout on successful execution", async () => {
    mockRunCode.mockResolvedValue({
      logs: { stdout: ["Hello, World!\n"], stderr: [] },
      error: null,
    });
    const handler = await makeHandler();
    const result = await handler["runCode"](SCOPE, "python", { code: "print('Hello, World!')" }) as Record<string, unknown>;
    expect(result.stdout).toBe("Hello, World!");
    expect(result.stderr).toBeNull();
    expect(result.error).toBeNull();
    expect(typeof result.latencyMs).toBe("number");
    expect(result.lang).toBe("python");
  });

  it("always kills sandbox even on success", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: [], stderr: [] }, error: null });
    const handler = await makeHandler();
    await handler["runCode"](SCOPE, "python", { code: "pass" });
    expect(mockKill).toHaveBeenCalledOnce();
  });

  it("propagates sandbox error as result.error (not thrown)", async () => {
    mockRunCode.mockResolvedValue({
      logs: { stdout: [], stderr: [] },
      error: { value: "NameError: name 'x' is not defined" },
    });
    const handler = await makeHandler();
    const result = await handler["runCode"](SCOPE, "python", { code: "print(x)" }) as Record<string, unknown>;
    expect(result.error).toContain("NameError");
    expect(mockKill).toHaveBeenCalledOnce();
  });

  it("kills sandbox even when runCode throws", async () => {
    mockRunCode.mockRejectedValue(new Error("network error"));
    const handler = await makeHandler();
    await expect(handler["runCode"](SCOPE, "python", { code: "pass" })).rejects.toThrow("network error");
    expect(mockKill).toHaveBeenCalledOnce();
  });

  it("throws clear error when E2B_API_KEY is missing", async () => {
    const handler = await makeHandler({ E2B_API_KEY: null });
    await expect(
      handler["runCode"](SCOPE, "python", { code: "print('hi')" })
    ).rejects.toThrow("E2B_API_KEY");
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });

  it("throws when code is empty", async () => {
    const handler = await makeHandler();
    await expect(
      handler["runCode"](SCOPE, "python", { code: "" })
    ).rejects.toThrow("code is required");
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });

  it("clamps timeoutMs to 60s maximum", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: [], stderr: [] }, error: null });
    const handler = await makeHandler();
    await handler["runCode"](SCOPE, "python", { code: "pass", timeoutMs: 999_999 });
    expect(mockRunCode).toHaveBeenCalledWith("pass", { timeoutMs: 60_000 });
  });

  it("routes node language with js language param", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: ["42\n"], stderr: [] }, error: null });
    const handler = await makeHandler();
    const result = await handler["runCode"](SCOPE, "node", { code: "console.log(42)" }) as Record<string, unknown>;
    expect(result.lang).toBe("node");
    expect(mockRunCode).toHaveBeenCalledWith("console.log(42)", { timeoutMs: 15_000, language: "js" });
  });
});

describe("platos.code_execution — install_package", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });
  });

  it("rejects package names with shell-dangerous characters", async () => {
    const handler = await makeHandler();
    await expect(
      handler["installPackage"](SCOPE, { packages: ["../evil; rm -rf /"] })
    ).rejects.toThrow("no valid package names");
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });

  it("accepts valid package names and returns result", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: ["Installed: pandas"], stderr: [] }, error: null });
    const handler = await makeHandler();
    const result = await handler["installPackage"](SCOPE, { packages: ["pandas", "numpy"] }) as Record<string, unknown>;
    expect(result.packages).toEqual(["pandas", "numpy"]);
    expect(result.manager).toBe("pip");
    expect(mockKill).toHaveBeenCalledOnce();
  });

  it("accepts a single string package name", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: ["Installed: requests"], stderr: [] }, error: null });
    const handler = await makeHandler();
    const result = await handler["installPackage"](SCOPE, { packages: "requests" }) as Record<string, unknown>;
    expect(result.packages).toEqual(["requests"]);
  });

  it("accepts versioned packages like scikit-learn>=1.0", async () => {
    mockRunCode.mockResolvedValue({ logs: { stdout: [], stderr: [] }, error: null });
    const handler = await makeHandler();
    const result = await handler["installPackage"](SCOPE, { packages: ["scikit-learn>=1.0"] }) as Record<string, unknown>;
    expect(result.packages).toEqual(["scikit-learn>=1.0"]);
  });
});
