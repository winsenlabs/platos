"""Platools CLI entrypoint — `platools <subcommand>`.

Subcommands:
  - `doctor` (PLATOS-18) — static tool-graph analyzer
  - `test`   (PLATOS-19) — runtime tool exerciser (TBD)
  - `serve`  (PLATOS-41) — local SDK runner (TBD)

`pyproject.toml [project.scripts]` wires `platools = platools.cli:main`,
so the entry point lands here. We dispatch to subcommand modules via
the first positional arg — argparse keeps the top-level surface tiny
and lets each subcommand own its own flag parser.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        _print_help()
        return 0

    subcommand, rest = args[0], args[1:]
    if subcommand == "doctor":
        from platools.cli.doctor import doctor_command

        return doctor_command(rest)
    if subcommand == "test":
        from platools.cli.test import test_command

        return test_command(rest)
    if subcommand == "serve":
        from platools.cli.serve import serve_command

        return serve_command(rest)

    print(f"platools: unknown subcommand {subcommand!r}", file=sys.stderr)
    _print_help()
    return 2


def _print_help() -> None:
    print(
        "platools — Your AI Arsenal\n"
        "\n"
        "Usage:\n"
        "  platools <subcommand> [args...]\n"
        "\n"
        "Subcommands:\n"
        "  doctor   Static tool-graph analyzer (PLATOS-18)\n"
        "  test     Runtime tool exerciser (PLATOS-19)\n"
        "  serve    Local MCP server (PLATOS-41)\n"
        "  help     Show this message\n"
    )
