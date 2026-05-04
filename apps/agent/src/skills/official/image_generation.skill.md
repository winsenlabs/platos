---
id: platos.image_generation
name: Image Generation
description: Generate images from a text prompt. Uses Black Forest Labs Flux by default, with OpenAI DALL-E as an alternate.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - images
  - multimodal
  - official
required_env:
  - BFL_API_KEY
optional_env:
  - OPENAI_API_KEY
provides_tools:
  - name: generate_image
    description: Generate an image from a text prompt. Returns a MinIO-backed URL that the frontend can render.
    inputSchema: {"type":"object","properties":{"prompt":{"type":"string","description":"Image description."},"size":{"type":"string","enum":["1024x1024","1024x1792","1792x1024"],"default":"1024x1024"},"model":{"type":"string","enum":["flux","dalle"],"default":"flux"}},"required":["prompt"]}
    handler: skill:platos.image_generation:generate_image
---

You can generate images from a text prompt.

**When to use:**
- User explicitly asks for a picture, diagram, thumbnail, or illustration.
- You want to render a chart / mock the user can see directly.

**Usage:**
- Write vivid but concise prompts (subject, style, composition, mood).
- The returned URL points at the conversation's MinIO bucket; the frontend handles rendering.
- Prefer `flux` for photoreal + design imagery; `dalle` for stylised illustration.
