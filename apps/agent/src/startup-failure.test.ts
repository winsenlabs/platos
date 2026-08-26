import { describe, expect, it, vi } from "vitest";
import { terminateAfterStartupFailure } from "./startup-failure";

describe("terminateAfterStartupFailure", () => {
  it("emits the stable Memory startup code and terminates immediately", () => {
    const write = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("process exited");
    });
    const failure = Object.assign(new Error("Memory profile migration is incomplete"), {
      code: "MEMORY_PROFILE_STARTUP_CONTRACT_INCOMPLETE",
    });

    expect(() => terminateAfterStartupFailure(failure, { write, exit })).toThrow("process exited");
    expect(write).toHaveBeenCalledWith(
      "[Platos agent] MEMORY_PROFILE_STARTUP_CONTRACT_INCOMPLETE: Memory profile migration is incomplete\n",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("redacts unexpected startup details before terminating", () => {
    const write = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("process exited");
    });

    expect(() => terminateAfterStartupFailure(
      new Error("postgresql://operator:secret@example.invalid/platos"),
      { write, exit },
    )).toThrow("process exited");
    expect(write.mock.calls[0]?.[0]).not.toContain("secret");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
