---
id: platos.file_operations
name: File Operations
description: Read and write files in the agent's per-conversation MinIO workspace.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - files
  - storage
  - official
required_env:
  - PLATOS_MINIO_ENDPOINT
  - PLATOS_MINIO_ACCESS_KEY
  - PLATOS_MINIO_SECRET_KEY
optional_env:
  - PLATOS_MINIO_REGION
provides_tools:
  - name: read_file
    description: Read a file from the agent's workspace bucket. Returns the file contents as text.
    inputSchema: {"type":"object","properties":{"path":{"type":"string","description":"Relative path inside the workspace (e.g. \"notes/plan.md\")."}},"required":["path"]}
    handler: skill:platos.file_operations:read_file
  - name: write_file
    description: Write text content to a file in the agent's workspace bucket. Overwrites existing files.
    inputSchema: {"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"contentType":{"type":"string","default":"text/plain"}},"required":["path","content"]}
    handler: skill:platos.file_operations:write_file
  - name: list_dir
    description: List files under a prefix in the agent's workspace bucket.
    inputSchema: {"type":"object","properties":{"prefix":{"type":"string","default":""}}}
    handler: skill:platos.file_operations:list_dir
---

You have read/write access to a private workspace.

**Workspace layout:**
- Each thread gets an isolated prefix: `threads/<threadId>/`.
- Paths you pass are relative to that prefix (never absolute).
- Other threads, other agents, and other tenants cannot see files in this workspace.

**When to use:**
- Persist intermediate results between turns.
- Build up a document iteratively across the conversation.
- Hand off a file to a downstream tool that accepts a `platos-attachment://` URI.
