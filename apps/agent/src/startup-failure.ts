export function terminateAfterStartupFailure(
  error: unknown,
  io: {
    write: (message: string) => void;
    exit: (code: number) => never;
  } = {
    write: (message) => process.stderr.write(message),
    exit: (code) => process.exit(code),
  },
): never {
  const code = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : "PLATOS_AGENT_STARTUP_FAILED";
  const message = code.startsWith("MEMORY_PROFILE_STARTUP_")
    && error instanceof Error
    ? error.message
    : "Agent startup failed; inspect service dependencies and configuration";
  io.write(`[Platos agent] ${code}: ${message}\n`);
  return io.exit(1);
}
