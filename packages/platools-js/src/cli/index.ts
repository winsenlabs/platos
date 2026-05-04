/**
 * Platools CLI dispatcher — `platools <subcommand>`.
 *
 * Ported from `platools/cli/__init__.py`. Subcommands:
 *
 *   - `doctor` — static tool-graph analyzer (PLATOS-18)
 *   - `test`   — runtime tool exerciser (PLATOS-19)
 *
 * `package.json` wires the `platools` bin to `./dist/bin/cli.js`
 * (a thin shim that imports `main()` from here). Each subcommand
 * owns its own flag parser; this module just dispatches the first
 * positional arg.
 */

import { doctorCommand } from "./doctor.js";
import { testCommand } from "./test.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  const subcommand = args[0]!;
  const rest = args.slice(1);

  switch (subcommand) {
    case "doctor":
      return doctorCommand(rest);
    case "test":
      return testCommand(rest);
    default:
      process.stderr.write(`platools: unknown subcommand "${subcommand}"\n`);
      process.stderr.write(helpText());
      return 2;
  }
}

export function helpText(): string {
  return [
    "platools — Your AI Arsenal",
    "",
    "Usage:",
    "  platools <subcommand> [args...]",
    "",
    "Subcommands:",
    "  doctor   Static tool-graph analyzer (PLATOS-18)",
    "  test     Runtime tool exerciser (PLATOS-19)",
    "  help     Show this message",
    "",
  ].join("\n");
}

// Note: this module is import-safe. The `platools` bin is wired via
// `src/bin/cli.ts`, which imports `main()` and drives process.exit.
// Keeping `cli/index.ts` side-effect free lets tests import it to
// exercise the dispatcher without the top-level running the CLI.
