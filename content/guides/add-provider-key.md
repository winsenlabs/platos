---
slug: add-provider-key
title: Add a provider key (BYOK)
description: Create and link an OpenAI, Anthropic, or other credential to one Platos Environment.
category: getting-started
order: 30
questions:
  - "Where do I add my OpenAI API key?"
  - "How do I scope a key to one environment?"
  - "How does Platos verify the key works?"
  - "How do I rotate a key without breaking active agents?"
  - "Why is the model picker empty even though I have a key?"
related:
  - quickstart
  - create-first-agent
---

# Add a provider key (BYOK)

Platos runs on dashboard-managed provider credentials. Raw values are encrypted in the Platos-native store for one Environment; provider rows and agent configs retain references only.

## The goal

A linked Anthropic or OpenAI key in your `dev` environment. After this, the Providers page shows the provider as healthy and the model picker fills in with the provider's models.

## Mental model

A "provider" is a slot Platos knows about (Anthropic, OpenAI, Google, Vertex, and OpenAI-compatible providers). Each slot declares a conventional bare credential name. The Providers page creates the encrypted Environment credential and provider reference together.

The agent resolves only the dashboard credential store. A matching value in the agent process environment is not a fallback and does not make the provider available.

## Steps

1. **Get the key.**

   From your provider's dashboard:

   - Anthropic: `https://console.anthropic.com/keys`
   - OpenAI: `https://platform.openai.com/api-keys`
   - Google: Vertex AI service account or AI Studio API key.

   Make sure billing is set up. Platos uses the key directly for inference.

2. **Create the Environment credential and reference.**

   Open Providers for the target Environment, choose **Add key** under the provider, and use the manifest's bare name:

   ```text
   ANTHROPIC_API_KEY
   OPENAI_API_KEY
   GOOGLE_GENERATIVE_AI_API_KEY
   ```

   Paste the raw value only into the credential create form. It is encrypted immediately and is not returned by list, health, provider, or MCP APIs.

3. **Enable/link the provider.**

   Select the new key as default when required, then enable/link the provider. Provider tools retain the name/reference only, not plaintext.

4. **Verify on the Providers page.**

   Sidebar to Providers (`/orgs/{org}/projects/{project}/env/dev/agent-providers`). The provider card flips to a green health badge within a few seconds. The badge runs a cheap "list models" call against the key.

## Verify

- The provider card on Providers shows green status.
- The agent creation wizard's model picker now lists this provider's models.
- A test chat turn streams without `PROVIDER_NOT_LINKED` errors.

## Rotate without downtime

Rotate the credential in the dashboard. The update atomically activates a new secret revision; no provider-link or agent-config edit is required. Turns already holding the old material may finish, while subsequent reads use the replacement. The immutable audit must persist or rotation fails closed.

## Multiple keys for the same provider

For separate regions or cost centers, create distinctly named/labeled credentials in the same Environment and link each to the provider. Agents can pin a specific provider-key reference or use the Environment default.

## Common pitfalls

- **Model picker is empty.** No dashboard credential is linked in this Environment. A installation env var does not count.
- **Health check fails with 401.** The provider rejected the credential. Rotate it in the dashboard.
- **Health check fails with 429 or quota error.** The key is valid but the provider account has hit a rate limit or billing issue. Fix on the provider's dashboard.
- **Wrong reference name.** Check the provider manifest/dashboard hint. `OPENAI_KEY` does not resolve a credential named `OPENAI_API_KEY`.
- **Plaintext pasted into a reference field.** Provider and MCP configuration fields store references only; create the credential first.

## Next steps

- [Create your first agent](/guides/create-first-agent) using the new provider's model.
- For separate `prod` keys, create a credential in the production Environment. Credentials do not cross Environment boundaries.
- [Self-host with docker compose](/guides/install-self-host) covers the broader env-var lifecycle.
