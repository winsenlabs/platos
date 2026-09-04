import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { AUTH_REFUSAL_STATUSES, describe as describeFailure, isAbort, isAuthRefusal, toFinishReason, translate } from "./failure.js";

function apiError(statusCode: number | undefined, message = "refused"): APICallError {
  return new APICallError({
    message,
    url: "https://provider.example/v1/messages",
    requestBodyValues: { messages: [{ role: "user", content: "the user's private prompt" }] },
    statusCode,
    responseBody: "the provider echoed the request back",
  });
}

describe("recognising an abort", () => {
  it("recognises an aborted signal even when the error says nothing", () => {
    const controller = new AbortController();
    controller.abort();

    expect(isAbort(new Error("who knows"), controller.signal)).toBe(true);
  });

  it("recognises the runtime's own abort error with no signal to hand", () => {
    expect(isAbort(Object.assign(new Error("x"), { name: "AbortError" }), null)).toBe(true);
    expect(isAbort(Object.assign(new Error("x"), { code: "ABORT_ERR" }), null)).toBe(true);
  });

  it("does not read an ordinary failure as an abort", () => {
    const controller = new AbortController();

    expect(isAbort(new Error("upstream exploded"), controller.signal)).toBe(false);
    expect(isAbort(null, null)).toBe(false);
    expect(isAbort("a string", null)).toBe(false);
  });
});

describe("recognising a refusal of the credential", () => {
  it("names exactly the two statuses that condemn a key", () => {
    expect(AUTH_REFUSAL_STATUSES).toEqual([401, 403]);
    expect(isAuthRefusal(apiError(401))).toBe(true);
    expect(isAuthRefusal(apiError(403))).toBe(true);
  });

  it("does not condemn a key over an outage, a rate limit or a bad request", () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      expect(isAuthRefusal(apiError(status))).toBe(false);
    }
  });

  it("does not condemn a key over a failure that never reached the provider", () => {
    expect(isAuthRefusal(new Error("ECONNRESET"))).toBe(false);
    expect(isAuthRefusal(apiError(undefined))).toBe(false);
  });
});

describe("describing a failure safely", () => {
  it("names the class and the status and nothing else", () => {
    expect(describeFailure(apiError(429))).toBe("AI_APICallError: 429");
  });

  it("does not carry the request or the response body, which can echo a prompt", () => {
    const described = describeFailure(apiError(400));

    expect(described).not.toContain("private prompt");
    expect(described).not.toContain("echoed the request");
  });

  it("describes a plain error and a thrown non-error", () => {
    expect(describeFailure(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeFailure("just a string")).toBe("the provider client failed without an error value");
  });
});

describe("translating", () => {
  it("keeps an abandoned generation apart from an outage", () => {
    const controller = new AbortController();
    controller.abort();

    expect(translate(new Error("x"), controller.signal).code).toBe("PROVIDERS_GENERATION_ABORTED");
    expect(translate(new Error("x"), null).code).toBe("PROVIDERS_PROVIDER_REQUEST_FAILED");
  });

  it("shows a client one fixed sentence and keeps the diagnosis in details", () => {
    const error = translate(apiError(500), null);

    expect(error.message).toBe("Provider request failed.");
    expect(error.details.reason).toBe("AI_APICallError: 500");
  });
});

describe("the finish reason", () => {
  it("carries the five names the two vocabularies share", () => {
    for (const reason of ["stop", "length", "tool-calls", "content-filter", "error"]) {
      expect(toFinishReason(reason)).toBe(reason);
    }
  });

  it("reads anything else as `other` rather than inventing a name", () => {
    expect(toFinishReason("unknown")).toBe("other");
    expect(toFinishReason(undefined)).toBe("other");
    // `aborted` exists only on this side and is set by whoever saw the abort.
    expect(toFinishReason("aborted")).toBe("other");
  });
});
