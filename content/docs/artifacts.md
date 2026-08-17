---
slug: artifacts
title: Artifacts
description: Platos-generated structured outputs (markdown, code, html-sandboxed, json, csv, svg, image) that render consistently in any client.
category: platform
order: 180
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is an artifact and how is it different from a tool result?"
  - "Which artifact types are canonical?"
  - "How do I render an artifact in my own UI?"
  - "How are HTML artifacts sandboxed?"
  - "How does the agent emit an artifact mid-stream?"
  - "Can a tool result be promoted to an artifact?"
related:
  - attachments-and-files
  - chat-and-postman
  - sdks
source_files_referenced:
  - apps/agent/src/agent-runtime/artifact-meta.ts
  - apps/agent/src/agent-runtime/artifact-meta.test.ts
  - apps/agent/src/agent-runtime/agent.controller.ts
  - packages/platos-client/src/apis/threads.ts
  - docs/themes/THEME_F.md
---

# Artifacts

An artifact is a Platos-generated structured output that renders consistently in any client. Where a tool result is "the entity returned this", an artifact is "the agent built this": a draft document, a code snippet, a chart, a sandboxed HTML preview. The seven canonical types cover most agent output needs without exploding into ad-hoc renderers.

## What it is

Seven canonical types:

- `markdown`: long-form prose with markdown formatting.
- `code`: a code block with language metadata.
- `html-sandboxed`: HTML rendered inside a sandboxed iframe with no network or storage access.
- `json`: structured data the consumer can parse and render.
- `csv`: tabular data.
- `svg`: vector graphics.
- `image`: a reference to a binary image (typically MinIO-hosted).

Artifacts are emitted via `generate_artifact` and `revise_artifact` meta-tools. The meta-tool wraps the LLM response in an `<PlatosArtifact>` envelope; the runtime persists the row, streams an `artifact-created` event over the websocket, and the consumer renders.

`@platosdev/client` ships a `<PlatosArtifact>` component that picks the renderer based on type and applies the sandbox guarantees (CSP, iframe isolation, etc.).

## Why it matters

Without a structured artifact protocol, every agent output ends up as a wall of text. The user has to copy-paste, the agent has to re-summarise, and the next turn loses the artifact entirely. Artifacts give the conversation a first-class "here is the deliverable" slot. The next turn can reference the artifact id and the agent can revise it without re-emitting the full content.

The sandboxed HTML type is the one that pays for itself. Letting the agent draft a working preview (form, chart, mock UI) without exposing the rest of the page or the user's storage is what makes Platos competitive with hosted runtimes that ship the same primitive.

## How to use it

### From an agent

The agent calls `generate_artifact({ type, title, content, mimeType? })`. The runtime persists, and emits a stream event:

```json
{ "type": "artifact-created", "artifactId": "art_abc", "artifactType": "code" }
```

Subsequent turns can reference the id and call `revise_artifact({ artifactId, patch })` to evolve it.

### Render in your UI

```tsx
import { PlatosArtifact } from "@platosdev/client/react";

<PlatosArtifact artifact={artifact} />;
```

Load a thread's artifacts with `client.threads.artifacts(threadId, scope)`, which calls the
canonical agent endpoint `GET /api/v1/agent/threads/:threadId/artifacts`. The component picks a
renderer by type and applies the sandbox. Override per-type renderers via the `renderers` prop if
you have a custom UI.

`artifactKey` is an opaque persisted handle. Clients and migration code must preserve it exactly;
they must not derive or rewrite it from organization, project, or environment labels.

### Sandbox details

`html-sandboxed` artifacts render inside an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`, no `allow-forms`, no `allow-popups`). Network access is blocked by Content Security Policy; the artifact cannot fetch external resources. Storage and cookies are isolated.

### Promote a tool result

Some tool results are too good to leave as ephemeral output (a generated PDF, a long markdown summary). The runtime offers `promoteToArtifact({ toolCallId, type })` which wraps the tool's last response into an artifact row. Use it sparingly; tool results that are repeatedly promoted should become explicit artifact emits.

## Common pitfalls

- The artifact JSON envelope must be valid. The validator in `artifact-meta.ts` rejects malformed envelopes; the agent gets a tool error in response. Tests live alongside in `artifact-meta.test.ts`.
- Sandboxed HTML cannot make outbound network calls. If the artifact tries to fetch a CDN, it fails silently. Inline what you need.
- Artifacts are scoped to the conversation. They are not searchable across conversations. Memory or knowledge writes are the path for cross-conversation reference.
- Artifact size caps apply. Markdown, code, and JSON cap at ~256KB; binary types (image, large CSV) push to MinIO. The cap protects the streaming path from a 50MB artifact mid-turn.

## Related

- [Attachments and files](/docs/attachments-and-files): for binary uploads going into the conversation, not coming out of the agent.
- [Chat and Postman mode](/docs/chat-and-postman): the chat panel renders artifacts inline.
- [SDKs](/docs/sdks): `@platosdev/client` is the React + JS SDK that ships the renderer.
