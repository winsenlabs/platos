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
const mockCommandsRun = vi.fn();
const mockSetTimeout = vi.fn().mockResolvedValue(undefined);
const mockSandboxCreate = vi.fn();
const mockSandboxConnect = vi.fn();
const mockNextItems = vi.fn().mockResolvedValue([]); // default: no live session
const mockSandboxList = vi.fn(() => ({ nextItems: mockNextItems }));

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: mockSandboxCreate,
    connect: mockSandboxConnect,
    list: mockSandboxList,
  },
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
    mockNextItems.mockResolvedValue([]); // no live session by default → ephemeral create
    mockSandboxList.mockReturnValue({ nextItems: mockNextItems });
    const sandboxStub = {
      runCode: mockRunCode,
      kill: mockKill,
      setTimeout: mockSetTimeout,
      commands: { run: mockCommandsRun },
    };
    mockSandboxCreate.mockResolvedValue(sandboxStub);
    mockSandboxConnect.mockResolvedValue(sandboxStub);
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
    mockNextItems.mockResolvedValue([]); // no live session by default → ephemeral create
    mockSandboxList.mockReturnValue({ nextItems: mockNextItems });
    const sandboxStub = {
      runCode: mockRunCode,
      kill: mockKill,
      setTimeout: mockSetTimeout,
      commands: { run: mockCommandsRun },
    };
    mockSandboxCreate.mockResolvedValue(sandboxStub);
    mockSandboxConnect.mockResolvedValue(sandboxStub);
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

describe("platos.code_execution — run_shell (CLI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNextItems.mockResolvedValue([]);
    mockSandboxList.mockReturnValue({ nextItems: mockNextItems });
    const stub = { runCode: mockRunCode, kill: mockKill, setTimeout: mockSetTimeout, commands: { run: mockCommandsRun } };
    mockSandboxCreate.mockResolvedValue(stub);
    mockSandboxConnect.mockResolvedValue(stub);
  });

  it("runs a command and returns exitCode + stdout", async () => {
    mockCommandsRun.mockResolvedValue({ exitCode: 0, stdout: "file.txt\n", stderr: "" });
    const handler = await makeHandler();
    const result = await handler["runShell"](SCOPE, { command: "ls" }) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt");
    expect(mockCommandsRun).toHaveBeenCalledWith("ls", { timeoutMs: 30_000 });
  });

  it("returns non-zero exit as data (not a thrown error)", async () => {
    const exitErr: any = new Error("command failed");
    exitErr.exitCode = 2;
    exitErr.stderr = "fatal: not a git repo";
    exitErr.stdout = "";
    mockCommandsRun.mockRejectedValue(exitErr);
    const handler = await makeHandler();
    const result = await handler["runShell"](SCOPE, { command: "git status" }) as Record<string, unknown>;
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not a git repo");
  });

  it("requires E2B_API_KEY", async () => {
    const handler = await makeHandler({ E2B_API_KEY: null });
    await expect(handler["runShell"](SCOPE, { command: "ls" })).rejects.toThrow("E2B_API_KEY");
  });

  it("requires a command", async () => {
    const handler = await makeHandler();
    await expect(handler["runShell"](SCOPE, { command: "  " })).rejects.toThrow("command is required");
  });

  it("clamps timeoutMs to 120s max", async () => {
    mockCommandsRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const handler = await makeHandler();
    await handler["runShell"](SCOPE, { command: "sleep 1", timeoutMs: 999_999 });
    expect(mockCommandsRun).toHaveBeenCalledWith("sleep 1", { timeoutMs: 120_000 });
  });
});

describe("platos.code_execution — persistent thread session", () => {
  const THREAD_SCOPE = { ...SCOPE, threadId: "thr_abc" } as typeof SCOPE & { threadId: string };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxList.mockReturnValue({ nextItems: mockNextItems });
    const stub = { runCode: mockRunCode, kill: mockKill, setTimeout: mockSetTimeout, commands: { run: mockCommandsRun } };
    mockSandboxCreate.mockResolvedValue(stub);
    mockSandboxConnect.mockResolvedValue(stub);
    mockRunCode.mockResolvedValue({ logs: { stdout: ["ok"], stderr: [] }, error: null });
  });

  it("reconnects to an existing session sandbox and does NOT kill it", async () => {
    mockNextItems.mockResolvedValue([{ sandboxId: "sbx_live" }]);
    const handler = await makeHandler();
    const result = await handler["runCode"](THREAD_SCOPE, "python", { code: "print(1)" }) as Record<string, unknown>;
    expect(mockSandboxConnect).toHaveBeenCalledWith("sbx_live", expect.objectContaining({ apiKey: "test-key" }));
    expect(mockSandboxCreate).not.toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled(); // session persists
    expect(result.sessionPersistent).toBe(true);
  });

  it("creates a thread-tagged session when none exists, and keeps it alive", async () => {
    mockNextItems.mockResolvedValue([]); // no live session
    const handler = await makeHandler();
    const result = await handler["runCode"](THREAD_SCOPE, "python", { code: "print(1)" }) as Record<string, unknown>;
    expect(mockSandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { platosThread: "thr_abc", platos: "session" } }),
    );
    expect(mockKill).not.toHaveBeenCalled(); // session persists across calls
    expect(result.sessionPersistent).toBe(true);
  });

  it("ephemeral (no threadId) sandbox IS killed", async () => {
    const handler = await makeHandler();
    const result = await handler["runCode"](SCOPE, "python", { code: "print(1)" }) as Record<string, unknown>;
    expect(mockKill).toHaveBeenCalledOnce();
    expect(result.sessionPersistent).toBe(false);
  });
});
