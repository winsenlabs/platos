---
slug: send-attachment
title: Send an image or PDF attachment
description: Upload a file via presigned URL and let the agent see it as a multimodal input.
category: recipes
order: 40
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I upload an image to a chat?"
  - "How big can an attachment be?"
  - "How does the agent receive the image?"
  - "What if my model doesn't support vision?"
related:
  - create-first-agent
source_files_referenced:
  - apps/agent/src/agent-runtime/attachments.service.ts
  - apps/agent/src/agent-runtime/multimodal-adapter.ts
  - apps/webapp/app/routes/api.v1.agent.attachments.presigned.ts
---

# Send an image or PDF attachment

Upload a file directly to MinIO via a presigned URL, then reference it in a chat message.

## The goal

A user message that includes an image or PDF; the agent processes it as a multimodal input on a vision-capable model, or text-falls-back on a non-vision model.

## Steps

1. **Get a presigned URL.**

   ```ts
   const presigned = await platos.attachments.presigned({
     filename: "invoice.pdf",
     mimeType: "application/pdf",
     conversationId,
   });
   ```

2. **Upload directly to MinIO.**

   ```ts
   await fetch(presigned.url, {
     method: "PUT",
     body: fileBlob,
     headers: { "Content-Type": "application/pdf" },
   });
   ```

   Bytes never touch the agent runtime.

3. **Send the message.**

   ```ts
   await platos.threads.update({
     threadId,
     messages: [{
       role: "user",
       content: "Summarise this invoice",
       attachments: [presigned.attachmentId],
     }],
   });
   ```

4. **Stream the response.**

   The agent receives the attachment in its turn assembly; the multimodal adapter routes it to the model.

## Verify

- Postman mode shows the attachment id in the assembled message.
- The trace shows a `multimodal.adapt` span with `mimeType: application/pdf`.
- The reply references the attachment's content.

## Vision routing

When the agent's model has `vision: true`, image bytes (or signed URLs) are inlined. PDFs are converted to page images plus extracted text. Non-vision models receive a text fallback ("the user attached an image: <filename>") plus a tool call to `platos-code-runner` if image processing is needed.

## Limits

- Default per-file cap: 50 MB.
- Default mime types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`, `text/csv`, `text/plain`, `application/json`.
- Retention: project default (configurable, see [Attachments and files](/docs/attachments-and-files)).

## Next steps

- [Filter PII](/guides/filter-pii) before the attachment text reaches the model.
- See `platos-code-runner` for sandboxed PDF extraction.
