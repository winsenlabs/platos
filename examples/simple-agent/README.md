# Simple Agent Example

A minimal example of deploying an agent on Platos. This agent:
- Responds to chat messages
- Can search the web (via tools)
- Remembers facts across conversations
- Streams responses in real-time

## Setup

1. Start Platos services:
```bash
cd /path/to/platos
cp .env.example .env
# Before Compose model evaluation, replace every required development sentinel
# documented in content/docs/self-hosting.md.
docker compose -f docker-compose.platos.yml up -d postgres redis clickhouse minio
pnpm run db:migrate
```

2. Start the agent service:
```bash
cd apps/agent
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/platos_control" \
REDIS_URL="redis://localhost:6379" \
PLATOS_TEST_MODE="true" \
node dist/main.js
```

For real model calls, configure a provider credential for the authenticated Environment in the dashboard. The agent does not fall back to a provider key in its process environment.

3. Register an org and test tools:
```bash
# Register your org
curl -X POST http://localhost:3100/api/v1/agent/orgs \
  -H "Content-Type: application/json" \
  -H "X-Platos-Org-Id: my-org" \
  -H "X-Platos-User-Id: admin" \
  -d '{"orgId": "my-org", "displayName": "My Org", "mcpUrls": [], "serviceSecret": "my-secret"}'

# Register some tools
curl -X POST http://localhost:3100/test/tools/register \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "my-org",
    "tools": [
      {"name": "search_web", "description": "Search the web for information", "paramSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
      {"name": "get_weather", "description": "Get current weather for a city", "paramSchema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
    ],
    "callbackUrl": "http://localhost:8000/mcp"
  }'
```

4. Create a thread and send a message:
```bash
# Create thread
curl -X POST http://localhost:3100/api/v1/agent/threads \
  -H "Content-Type: application/json" \
  -H "X-Platos-Org-Id: my-org" \
  -H "X-Platos-User-Id: admin" \
  -d '{"agentId": "default", "title": "My First Conversation"}'

# Send a message (non-streaming)
curl -X POST http://localhost:3100/api/v1/agent/threads/{THREAD_ID}/messages \
  -H "Content-Type: application/json" \
  -H "X-Platos-Org-Id: my-org" \
  -H "X-Platos-User-Id: admin" \
  -d '{"message": "Hello! What can you help me with?"}'
```

5. Or use WebSocket for streaming:
```javascript
const { io } = require("socket.io-client");

const socket = io("http://localhost:3100/agent", {
  auth: { orgId: "my-org", userId: "admin" },
  transports: ["websocket"],
});

socket.on("connected", (data) => {
  console.log("Connected:", data);
  socket.emit("message", {
    message: "What's the weather in San Francisco?",
    agentId: "default",
  });
});

socket.on("agent_event", (event) => {
  switch (event.type) {
    case "token":
      process.stdout.write(event.text);
      break;
    case "tool_call":
      console.log("\n[Tool Call]", event.name, event.params);
      break;
    case "done":
      console.log("\n[Done]");
      process.exit(0);
  }
});
```

## What This Demonstrates

- **Agent configuration**: model, system prompt, meta-tools
- **Tool discovery**: BM25 search finds relevant tools from registered set
- **Tool execution**: calls the org's MCP endpoint with HMAC auth
- **Memory**: remembers facts across conversations via Redis
- **Streaming**: real-time token streaming via WebSocket
- **Org isolation**: all data scoped by org_id + user_id
