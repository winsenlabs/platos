# Python example — platos-client

Async CLI that connects to a Platos agent and streams a reply to stdout.

```bash
pip install platos-client
export PLATOS_BASE_URL="http://localhost:3100"
export PLATOS_SESSION_TOKEN="<session token minted by your backend>"
export PLATOS_AGENT_ID="<agent id>"
python cli.py "Hello, agent!"
```
