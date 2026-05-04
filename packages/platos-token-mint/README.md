# `@platos/token-mint`

Mint [Platos](https://platos.dev) session tokens from your backend.

A Platos session token is an HS256 JWT signed with your entity's `serviceSecret`. This library takes `(serviceSecret, claims, ttl)` and hands you back the string your frontend can pass to `@platos/client`.

## Why this exists

Every customer wiring up Platos previously had to implement HS256 signing against a specific byte layout from scratch. The spec is small but easy to get wrong — base64url padding, claim ordering, signature base construction are all traps. This library bakes in the correct recipe plus test vectors.

## Install

```bash
npm install @platos/token-mint
```

## Use

```ts
// server.ts
import { mintSessionToken } from "@platos/token-mint";

app.post("/api/platos-session", async (req, res) => {
  const token = mintSessionToken({
    serviceSecret: process.env.PLATOS_ENTITY_SERVICE_SECRET!,
    claims: {
      organizationId: "org_abc",
      projectId:      "prj_def",
      environmentId:  "env_ghi",
      userId:         req.session.userId,
      entityId:       "my-entity",
      userToken:      req.session.userToken, // forwarded to your tool backend
    },
    ttlSeconds: 3600, // 1 hour
  });
  res.json({ token });
});
```

```tsx
// client.tsx
import { PlatosClient } from "@platos/client";

const res = await fetch("/api/platos-session", { method: "POST" });
const { token } = await res.json();

const platos = new PlatosClient({
  baseUrl: "https://platos.example.com",
  sessionToken: token,
  onTokenRefresh: async () => {
    const r = await fetch("/api/platos-session", { method: "POST" });
    const body = await r.json();
    return body.token;
  },
});
```

## Token format

The output is a standard JWT:

```
base64url(header) . base64url(payload) . base64url(hmac-sha256(header + "." + payload, serviceSecret))
```

Header:

```json
{ "alg": "HS256", "typ": "JWT" }
```

Payload example:

```json
{
  "organizationId": "org_abc",
  "projectId": "prj_def",
  "environmentId": "env_ghi",
  "userId": "usr_jkl",
  "entityId": "my-entity",
  "userToken": "opaque-proof-123",
  "iat": 1730000000,
  "exp": 1730003600
}
```

## Validation rules

- `serviceSecret` must be ≥ 16 chars. Shorter secrets are refused because the downstream HMAC has no lower-bound enforcement and we don't want customers stumbling into dev sentinel values.
- `ttlSeconds`: min 60s, max 7 days. The agent accepts longer-lived tokens but we refuse to mint them here — use `onTokenRefresh` instead.
- The four scope fields (`organizationId`, `projectId`, `environmentId`, `userId`) are required.

## Testing / introspection

```ts
import { decodeSessionToken } from "@platos/token-mint";

const { header, payload, signatureValid } = decodeSessionToken(token, serviceSecret);
// signatureValid === true when the signature matches.
```

Production traffic is verified by the agent itself — don't call this in a hot path.

## Test vectors

See `__tests__/vectors.test.ts` for deterministic input → output pairs against known secrets. Use these to port this library to other languages (Python + Go stubs coming in v0.2).

## Licence

Apache 2.0.
