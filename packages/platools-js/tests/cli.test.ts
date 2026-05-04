/**
 * CLI dispatcher + argparse tests.
 *
 * The CLI's actual command implementations are covered by
 * `doctor.test.ts` and `runner.test.ts`. This file locks down the
 * subcommand router, flag parsing, and help text so we don't ship a
 * CLI that silently drops a flag or misroutes a subcommand.
 */

import { describe, expect, it } from "vitest";

import { helpText, main } from "../src/cli/index.js";
import { parseDoctorArgs } from "../src/cli/doctor.js";
import { parseTestArgs } from "../src/cli/test.js";

describe("cli main dispatcher", () => {
  it("prints help and returns 0 for no args", async () => {
    const code = await main([]);
    expect(code).toBe(0);
  });

  it("returns 2 for unknown subcommand", async () => {
    const code = await main(["not-a-command"]);
    expect(code).toBe(2);
  });

  it("routes `doctor` to the doctor command", async () => {
    // No module, empty registry → 0.
    const code = await main(["doctor"]);
    expect(code).toBe(0);
  });

  it("helpText lists the known subcommands", () => {
    const text = helpText();
    expect(text).toContain("doctor");
    expect(text).toContain("test");
  });
});

describe("parseDoctorArgs", () => {
  it("defaults to no module path and text output", () => {
    const parsed = parseDoctorArgs([]);
    expect(parsed.modulePath).toBeUndefined();
    expect(parsed.outputJson).toBe(false);
    expect(parsed.help).toBe(false);
  });

  it("captures a positional module path", () => {
    const parsed = parseDoctorArgs(["./dist/tools.js"]);
    expect(parsed.modulePath).toBe("./dist/tools.js");
  });

  it("captures --json", () => {
    const parsed = parseDoctorArgs(["--json"]);
    expect(parsed.outputJson).toBe(true);
  });

  it("captures --help", () => {
    expect(parseDoctorArgs(["--help"]).help).toBe(true);
    expect(parseDoctorArgs(["-h"]).help).toBe(true);
  });
});

describe("parseTestArgs", () => {
  it("defaults to batch mode with no flags set", () => {
    const parsed = parseTestArgs([]);
    expect(parsed.toolName).toBeUndefined();
    expect(parsed.batchFile).toBeUndefined();
    expect(parsed.showCoverage).toBe(false);
    expect(parsed.help).toBe(false);
  });

  it("captures a positional tool name and params", () => {
    const parsed = parseTestArgs(["refund", "--params", "{\"id\":1}"]);
    expect(parsed.toolName).toBe("refund");
    expect(parsed.paramsJson).toBe('{"id":1}');
  });

  it("captures --module and --file", () => {
    const parsed = parseTestArgs([
      "--module",
      "./tools.js",
      "--file",
      "tests.yaml",
    ]);
    expect(parsed.modulePath).toBe("./tools.js");
    expect(parsed.batchFile).toBe("tests.yaml");
  });

  it("captures --coverage", () => {
    expect(parseTestArgs(["--coverage"]).showCoverage).toBe(true);
  });

  it("captures --help", () => {
    expect(parseTestArgs(["--help"]).help).toBe(true);
    expect(parseTestArgs(["-h"]).help).toBe(true);
  });
});
