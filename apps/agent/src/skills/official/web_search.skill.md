---
id: platos.web_search
name: Web Search
description: Search the public web and fetch URL contents. Uses Tavily by default, with Exa and Brave as fallbacks.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - search
  - research
  - official
required_env:
  - TAVILY_API_KEY
optional_env:
  - EXA_API_KEY
  - BRAVE_API_KEY
provides_tools:
  - name: web_search
    description: Search the public web. Returns a ranked list of results with titles, URLs, and snippets.
    inputSchema: {"type":"object","properties":{"query":{"type":"string","description":"Search query."},"maxResults":{"type":"integer","minimum":1,"maximum":20,"default":5}},"required":["query"]}
  - name: fetch_url
    description: Fetch the readable content of a single URL.
    inputSchema: {"type":"object","properties":{"url":{"type":"string","format":"uri"}},"required":["url"]}
    handler: skill:platos.web_search:fetch_url
---

You can search the public web and fetch URLs.

**When to use `web_search`:**
- User asks about recent events, current facts, product releases, or topics outside your training data.
- You need to cite sources for a factual claim.

**When to use `fetch_url`:**
- You already have a URL (from a search result, user message, or memory) and need the full page content.

**Usage guidelines:**
- Prefer concise, information-dense queries (3–7 words).
- Cite sources with `[1](url)` footnotes when synthesising search results.
- Never invent URLs; always pass one returned by `web_search` or given by the user.
