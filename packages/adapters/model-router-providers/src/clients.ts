// The one place in the repository a provider client is constructed.
//
// `inference-sdk-only` and `provider-sdk-only` in scripts/arch/boundary-rules.mjs
// both name this package as their only home, and this file is where that
// permission is actually spent. Everything above it speaks `ModelRoutePlan`.
//
// THE PLAN IS HONOURED, NOT RE-DERIVED. Splitting `<provider>:<model>`, deciding
// the dialect, insisting on a per-resource root, normalising an operator's root
// and choosing the Vertex region are all decisions `domain/route.ts` has already
// made. This file reads a finished plan. That is the whole difference between
// this and the extraction source's `resolveModel`, which did the parsing and the
// client construction in one function and could therefore only be tested against
// a live provider.
//
// THE CREDENTIAL IS SPENT AND NOT STORED. `reveal()` is called once per
// construction, at the call site below, and the material goes straight into the
// client's own option. Nothing here caches it, logs it or reads an ambient one:
// a provider SDK's environment-variable discovery is exactly the failure the
// `ModelRouter` port exists to prevent, because it silently charges an
// installation-wide key for a tenant's work. Every `create*` call below passes
// an explicit key for that reason.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import {
  configurationUnavailable,
  err,
  ok,
  serviceAccountInvalid,
  type ModelRoutePlan,
  type ProviderCredential,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import type { LanguageModel } from "ai";

import type { HttpTransport } from "./transport.js";

/** The fields a Vertex service-account document must carry to be usable. */
interface ServiceAccountDocument {
  readonly project_id?: unknown;
  readonly client_email?: unknown;
  readonly private_key?: unknown;
}

function textField(document: ServiceAccountDocument, field: keyof ServiceAccountDocument): string | null {
  const value = document[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Read the service-account document a Vertex route is credentialed with.
 *
 * `private_key` arrives with its newlines escaped whenever the document has been
 * through an environment variable, and a key with literal backslash-n in it is
 * rejected by the signer with an error that names neither the field nor the
 * cause. Unescaping here is the difference between a working route and an hour
 * of looking at the wrong layer.
 *
 * EXPORTED FOR ONE REASON: the unescape is invisible from outside. Once the
 * document is inside the signing client there is no way to ask what key it
 * holds, so a test of `resolveModel` alone can only assert that a model was
 * built — which it is either way. A guard whose effect cannot be observed is a
 * guard no test can prove wrong.
 */
export function serviceAccount(material: string): Result<{ project: string; email: string; key: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(material);
  } catch {
    return err(serviceAccountInvalid("credential is not a JSON document", "google-vertex"));
  }
  if (parsed === null || typeof parsed !== "object") {
    return err(serviceAccountInvalid("credential is not a JSON object", "google-vertex"));
  }
  const document = parsed as ServiceAccountDocument;
  const project = textField(document, "project_id");
  const email = textField(document, "client_email");
  const key = textField(document, "private_key");
  if (project === null) return err(serviceAccountInvalid("no project_id in the document", "google-vertex"));
  if (email === null) return err(serviceAccountInvalid("no client_email in the document", "google-vertex"));
  if (key === null) return err(serviceAccountInvalid("no private_key in the document", "google-vertex"));
  return ok({ project, email, key: key.replace(/\\n/gu, "\n") });
}

/**
 * Bind a plan and a credential to a model handle.
 *
 * `chatCompletionsOnly` is what selects `.chat(model)` over the default entry
 * point, and it is a plan field rather than a guess: the default is the newer
 * responses surface, which a gateway or a third-party OpenAI-compatible upstream
 * does not implement, and getting it wrong yields a 404 from a provider that is
 * configured perfectly.
 */
export function resolveModel(
  plan: ModelRoutePlan,
  credential: ProviderCredential,
  transport: HttpTransport,
): Result<LanguageModel> {
  const model = plan.reference.modelName;
  const apiKey = credential.reveal();

  switch (plan.dialect) {
    case "anthropic-native":
      return ok(createAnthropic({ apiKey, fetch: transport })(model));

    case "openai-native":
      return ok(
        plan.baseUrl === null
          ? createOpenAI({ apiKey, fetch: transport })(model)
          : createOpenAI({ baseURL: plan.baseUrl, apiKey, fetch: transport }).chat(model),
      );

    case "openai-compatible":
      if (plan.baseUrl === null) {
        return err(configurationUnavailable("openai-compatible plan carries no base url", {
          provider: plan.reference.provider,
          model: plan.reference.modelString,
        }));
      }
      return ok(createOpenAI({ baseURL: plan.baseUrl, apiKey, fetch: transport }).chat(model));

    case "azure-openai":
      // Azure authenticates with an `api-key` HEADER rather than a bearer token.
      // The header is set explicitly instead of relying on the client's own
      // host sniffing, because a route reached through a private gateway does
      // not have `azure.com` in its root and would silently lose its auth.
      if (plan.baseUrl === null) {
        return err(configurationUnavailable("azure plan carries no per-resource base url", {
          provider: plan.reference.provider,
          model: plan.reference.modelString,
        }));
      }
      return ok(
        createOpenAI({
          baseURL: plan.baseUrl,
          apiKey,
          headers: { "api-key": apiKey },
          fetch: transport,
        })(model),
      );

    case "google-generative":
      return ok(createGoogleGenerativeAI({ apiKey, fetch: transport })(model));

    case "google-vertex": {
      const account = serviceAccount(apiKey);
      if (!account.ok) return err(account.error);
      // No custom transport here, and that is not an oversight. This client
      // builds its requests through a signing layer with its own retry and
      // token-refresh stack, and it does not take a `fetch`. Handing the retry
      // policy to a client that ignores it would be worse than not handing it
      // over: the policy would read as honoured and would not be.
      return ok(
        createVertex({
          project: account.value.project,
          location: plan.location ?? undefined,
          googleAuthOptions: {
            credentials: { client_email: account.value.email, private_key: account.value.key },
          },
        })(model),
      );
    }
  }
}
