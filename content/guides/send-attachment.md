---
slug: send-attachment
title: Send an image or PDF attachment
description: Attach a file to a Thread and include it with the next Turn input.
category: recipes
order: 4
questions:
  - "How do I attach an image to a Thread?"
  - "How does an Agent receive a PDF?"
related:
  - attachments-and-files
  - streaming
  - safety-and-pii
---

# Send an image or PDF attachment

Use the authenticated chat surface for upload negotiation. It binds the resulting object reference to the current Organization, Project, Environment, Thread, and end user before the Agent can read it.

## Steps

1. Open the target Thread in the authenticated chat surface.
2. Select or drop an allowed file.
3. Wait for the direct object-store upload to complete.
4. Send the next Turn input with the returned attachment reference.
5. Follow the Turn stream for adaptation, Tool Call, Artifact, and completion events.

## Verify

Operators can list the Thread's attachment metadata through the generated contract:

```http
GET /api/v1/agent/files/threads/{threadId}/attachments
```

The response is metadata-only. Object bytes remain protected by scoped object-store access.

## Model handling

Vision-capable models receive supported image content. PDF handling may combine extracted text and page images. A model without the required capability receives safe metadata or an explicit unsupported-input error instead of silently dropping the file.

Apply file-size, MIME-type, malware, PII, and retention policy before accepting the attachment. Use hard erasure when deletion requires a verified cross-store receipt.
