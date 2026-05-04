---
slug: attachments-and-files
title: Attachments and files
description: Upload files, images, and PDFs into a conversation and let the agent reference them as multimodal inputs.
category: platform
order: 190
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I attach a file to a chat message?"
  - "Where are uploaded files stored?"
  - "Which mime types does Platos accept?"
  - "How does Platos route an image to a vision-capable model?"
  - "How do I view all files uploaded to a project?"
  - "How long are attachments retained?"
related:
  - artifacts
  - conversations-and-threads
  - self-hosting
source_files_referenced:
  - apps/agent/src/agent-runtime/attachments.service.ts
  - apps/agent/src/agent-runtime/multimodal-adapter.ts
  - apps/agent/src/files/files.controller.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx
  - apps/webapp/app/routes/api.v1.agent.attachments.presigned.ts
  - apps/webapp/app/routes/api.v1.agent.attachments.retention.ts
  - docs/themes/THEME_D.md
---

# Attachments and files

Users upload files into a conversation; agents read them as multimodal inputs (images for vision models, PDFs as text plus images, CSVs through code-runner). Platos stores them in MinIO with scope-isolated buckets, presigns the upload URL so the file never touches the agent runtime, and routes the right modality bytes to the right model.

## What it is

`AttachmentsService` is the orchestrator. The flow:

1. Client calls `POST /api/v1/agent/attachments/presigned` with `{ filename, mimeType, conversationId }`. The runtime validates mime type, picks a bucket scoped to the project, and returns a presigned PUT URL.
2. Client uploads directly to MinIO with the presigned URL.
3. Client posts the message containing an `attachment` reference id.
4. The runtime ties the attachment to the message in `PlatosAttachment`, with `(scope, conversationId, messageId, key, mimeType, sizeBytes, retentionAt)`.
5. At turn assembly, `MultimodalAdapter` reads the attachment, decides whether to inline (small text), pass to a vision-capable model (image), or convert (PDF -> page images plus text).

`FilesController` is the operator-facing surface: list every file in a project, soft-delete, see retention status. The retention sweep runs on the trigger.dev queue and deletes attachments past their `retentionAt`.

Accepted mime types include `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`, `text/csv`, `text/plain`, `application/json`, plus the office types when the conversion adapter is configured.

## Why it matters

Most agent multimodality is wasted by routing every byte through the agent runtime. The presigned-upload pattern keeps the runtime out of the data path: a 50MB PDF lands in MinIO directly, the runtime only sees the reference. Same shape for outputs: an artifact image lives in MinIO, the streaming path emits the id.

Retention matters for compliance. A self-hosted Platos that keeps every attachment forever fails any GDPR audit. Per-project retention defaults plus per-attachment overrides let you wire a 30-day default for prod and 1-day for dev without thinking about it again.

## How to use it

### Attach from the chat panel

Drag a file onto the chat box. The UI calls the presigned endpoint, uploads to MinIO, and includes the reference in the next message. The agent receives the attachment in its turn assembly.

### Attach from the SDK

```ts
const presigned = await platos.attachments.presigned({
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  conversationId,
});

await fetch(presigned.url, { method: "PUT", body: fileBlob });

await platos.threads.update({
  threadId,
  messages: [{ role: "user", content: "Summarise this invoice", attachments: [presigned.attachmentId] }],
});
```

### Vision routing

When the agent's model is vision-capable (`vision: true` in the model catalog), the multimodal adapter inlines image bytes (or signed URLs) into the model request. Non-vision models get a text fallback ("the user attached an image: <filename>") plus a tool call to the [platos-code-runner](/docs/official-skills) skill if image processing is needed.

### List files

`/orgs/{org}/projects/{project}/env/{env}/files` shows every attachment across conversations with size, mime type, retention countdown, and a "view in conversation" link. Filter by user, mime type, or retention status.

### Set retention

`PATCH /api/v1/agent/attachments/retention` with `{ retentionDays }` updates the project default. Per-attachment overrides land via the same endpoint with `{ attachmentId, retentionAt }`.

## Common pitfalls

- MinIO bucket creation is at boot. A self-host that does not have its `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` set boots with a degraded attachment path; uploads fail with `MINIO_NOT_CONFIGURED`. See [Self-hosting](/docs/self-hosting).
- Presigned URLs are short-lived (15 minutes default). Clients that hold the URL too long get 403 on PUT. Re-call the presigned endpoint to refresh.
- Retention deletion is a soft job; an attachment past `retentionAt` may still be readable for a few minutes until the sweep runs. For hard delete, call `DELETE /api/v1/agent/attachments/:id`.
- Vision routing is per turn. If the agent's model changes between turns (canary, model routes), the same image might inline in one turn and text-fallback in the next. Pin your vision model on agents that depend on image understanding.

## Related

- [Artifacts](/docs/artifacts): the inverse direction (agent emits a binary).
- [Conversations and threads](/docs/conversations-and-threads): attachments are tied to messages within threads.
- [Self-hosting](/docs/self-hosting): the MinIO config that needs to be valid for attachments to work.
