/**
 * Theme I.10 — OpenAPI 3.1 spec for the Platos agent service.
 *
 * This is hand-curated rather than generated from NestJS decorators
 * because the monorepo doesn't currently ship `@nestjs/swagger`
 * (avoiding adding a new dependency during a round-4 SDK sprint).
 * Keep this in sync with `agent.controller.ts` — when you add a new
 * @Get/@Post/@Patch/@Delete there, mirror it here.
 *
 * Validated against OpenAPI 3.1 — paths start with `/api/v1/agent/`
 * matching the `@Controller("api/v1/agent")` prefix.
 */

import { env } from "../shared/env";

export const platosAgentOpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Platos Agent API",
    version: env.PLATOS_VERSION || "0.0.1",
    description:
      "REST surface for the Platos agent runtime. Socket.IO events and the `/mcp` gateway are documented separately in THEME_I.md §1.",
    license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  },
  servers: [
    { url: "https://test.platos.dev/api/v1/agent", description: "Hosted test env" },
    { url: "http://localhost:3100/api/v1/agent", description: "Local dev" },
  ],
  components: {
    securitySchemes: {
      sessionToken: {
        type: "apiKey",
        in: "header",
        name: "X-Platos-Session-Token",
        description:
          "Session-token JWT signed with `SESSION_SECRET` (platform-issued) or the entity's `serviceSecret` (entity-issued).",
      },
      directHeaders: {
        type: "apiKey",
        in: "header",
        name: "X-Platos-Organization-Id",
        description:
          "Mode-1 direct headers. Also requires `X-Platos-Project-Id`, `X-Platos-Environment-Id`, and `X-Platos-User-Id`.",
      },
      bearerApiKey: {
        type: "http",
        scheme: "bearer",
        description:
          "Mode-3 service-secret bearer token. Combined with the direct headers — the three modes can't mix on the same request.",
      },
    },
    parameters: {
      OrgHeader: {
        name: "X-Platos-Organization-Id",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Required in Mode 1 (direct headers).",
      },
      ProjectHeader: {
        name: "X-Platos-Project-Id",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
      EnvHeader: {
        name: "X-Platos-Environment-Id",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
      UserHeader: {
        name: "X-Platos-User-Id",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
    },
    schemas: {
      Agent: {
        type: "object",
        required: ["id", "name", "model", "systemPrompt", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          model: { type: "string" },
          systemPrompt: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        additionalProperties: true,
      },
      AgentsList: {
        type: "object",
        properties: {
          agents: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
        },
        required: ["agents"],
      },
      Thread: {
        type: "object",
        required: ["id", "agentId", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" },
          agentId: { type: "string" },
          title: { type: "string", nullable: true },
          status: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        additionalProperties: true,
      },
      ThreadsList: {
        type: "object",
        properties: {
          threads: { type: "array", items: { $ref: "#/components/schemas/Thread" } },
        },
        required: ["threads"],
      },
      Message: {
        type: "object",
        required: ["id", "threadId", "role", "content", "createdAt"],
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          role: {
            type: "string",
            enum: ["user", "assistant", "system", "tool"],
          },
          content: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
        additionalProperties: true,
      },
      MessagesList: {
        type: "object",
        properties: {
          messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
        },
        required: ["messages"],
      },
      Error: {
        type: "object",
        properties: {
          statusCode: { type: "integer" },
          message: { type: "string" },
          error: { type: "string" },
          validationErrors: { type: "array", items: { type: "string" } },
        },
        required: ["message"],
      },
    },
  },
  security: [{ sessionToken: [] }, { directHeaders: [] }, { bearerApiKey: [] }],
  paths: {
    "/agents": {
      get: {
        summary: "List agents in the caller's scope",
        tags: ["agents"],
        parameters: [
          { $ref: "#/components/parameters/OrgHeader" },
          { $ref: "#/components/parameters/ProjectHeader" },
          { $ref: "#/components/parameters/EnvHeader" },
          { $ref: "#/components/parameters/UserHeader" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AgentsList" } },
            },
          },
          "401": {
            description: "Missing / invalid auth",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        },
      },
      post: {
        summary: "Create a new agent",
        tags: ["agents"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "model", "systemPrompt"],
                properties: {
                  name: { type: "string" },
                  model: { type: "string" },
                  systemPrompt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Agent" } },
            },
          },
        },
      },
    },
    "/agents/{agentId}": {
      get: {
        summary: "Get an agent by id",
        tags: ["agents"],
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Agent" } },
            },
          },
          "404": {
            description: "Not found",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        },
      },
      patch: {
        summary: "Update an agent",
        tags: ["agents"],
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Agent" } },
            },
          },
        },
      },
      delete: {
        summary: "Delete an agent",
        tags: ["agents"],
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Deleted" } },
      },
    },
    "/agents/{agentId}/versions": {
      get: {
        summary: "List versions for an agent",
        tags: ["agents"],
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/agents/{agentId}/canary": {
      patch: {
        summary: "Update canary routing percent (Theme G.5)",
        tags: ["agents"],
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["percent"],
                properties: { percent: { type: "integer", minimum: 0, maximum: 100 } },
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
    },
    "/threads": {
      post: {
        summary: "Create a thread",
        tags: ["threads"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["agentId"],
                properties: {
                  agentId: { type: "string" },
                  title: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Thread" } },
            },
          },
        },
      },
      get: {
        summary: "List threads in the caller's scope",
        tags: ["threads"],
        parameters: [
          { name: "agentId", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ThreadsList" } },
            },
          },
        },
      },
    },
    "/threads/{threadId}": {
      get: {
        summary: "Get a thread",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Thread" } },
            },
          },
        },
      },
      patch: {
        summary: "Update a thread",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
          },
        },
        responses: { "200": { description: "OK" } },
      },
      delete: {
        summary: "Delete a thread",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Deleted" } },
      },
    },
    "/threads/{threadId}/messages": {
      get: {
        summary: "List messages in a thread",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MessagesList" } },
            },
          },
        },
      },
      post: {
        summary: "Send a message (non-streaming) — returns the final assistant message",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string" },
                  agentId: { type: "string" },
                  dynamicBlocks: { type: "object", additionalProperties: { type: "string" } },
                  attachmentIds: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Final message",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Message" } },
            },
          },
        },
      },
    },
    "/threads/{threadId}/stream": {
      post: {
        summary:
          "Send a message and stream the response as server-sent events (SSE). See THEME_I.md §1 for event shape.",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string" },
                  agentId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "text/event-stream of AgentStreamEvent",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/threads/{threadId}/artifacts": {
      get: {
        summary: "List artifacts attached to a thread",
        tags: ["threads"],
        parameters: [{ name: "threadId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/connect": {
      get: {
        summary: "Fetch the per-scope connection details block (hostnames + auth skeleton)",
        tags: ["connect"],
        responses: { "200": { description: "OK" } },
      },
    },
    "/providers": {
      get: {
        summary: "List active LLM providers in the caller's scope",
        tags: ["providers"],
        responses: { "200": { description: "OK" } },
      },
    },
    "/providers/models": {
      get: {
        summary: "List selectable models filtered by linked provider env",
        tags: ["providers"],
        responses: { "200": { description: "OK" } },
      },
    },
  },
} as const;

export type PlatosAgentOpenApiSpec = typeof platosAgentOpenApiSpec;
