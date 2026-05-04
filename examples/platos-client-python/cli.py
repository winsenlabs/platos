"""Minimal Python CLI using platos-client. Theme I.11.

Usage:
    export PLATOS_BASE_URL=...
    export PLATOS_SESSION_TOKEN=...
    export PLATOS_AGENT_ID=...
    python cli.py "your prompt"
"""

from __future__ import annotations

import asyncio
import os
import sys

from platos_client import PlatosClient, PlatosError


async def main() -> None:
    base_url = os.environ.get("PLATOS_BASE_URL")
    session_token = os.environ.get("PLATOS_SESSION_TOKEN")
    agent_id = os.environ.get("PLATOS_AGENT_ID")
    prompt = " ".join(sys.argv[1:]) or "Say hello in one sentence."

    if not base_url or not session_token or not agent_id:
        print(
            "Missing env. Set PLATOS_BASE_URL, PLATOS_SESSION_TOKEN, and PLATOS_AGENT_ID.",
            file=sys.stderr,
        )
        sys.exit(1)

    async with PlatosClient(base_url=base_url, session_token=session_token) as client:
        thread = await client.threads.create(agent_id=agent_id)
        print(f"[thread {thread['id']}]", file=sys.stderr)
        try:
            async for event in client.threads.send(thread["id"], prompt, agent_id=agent_id):
                t = event.get("type")
                if t == "token":
                    print(event.get("text", ""), end="", flush=True)
                elif t == "tool_call":
                    print(f"\n[tool → {event.get('name')}]", file=sys.stderr)
                elif t == "reconnecting":
                    print(f"\n[reconnecting attempt {event.get('attempt')}]", file=sys.stderr)
                elif t == "error":
                    print(f"\n[error] {event.get('message')}", file=sys.stderr)
                elif t == "done":
                    print()
                    return
        except PlatosError as err:
            print(f"\nPlatos error {err.status}: {err}", file=sys.stderr)
            sys.exit(2)


if __name__ == "__main__":
    asyncio.run(main())
