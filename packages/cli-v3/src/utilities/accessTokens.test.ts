import { describe, expect, it } from "vitest";
import { validateAccessToken } from "./accessTokens.js";

describe("validateAccessToken", () => {
  it("accepts the retained plt_pat_ user API token", () => {
    expect(validateAccessToken("plt_pat_example")).toEqual({ success: true, type: "personal" });
  });

  it("rejects the retired tr_pat_ family", () => {
    expect(validateAccessToken("tr_pat_retired")).toEqual({ success: false });
  });

  it("preserves organization access tokens", () => {
    expect(validateAccessToken("tr_oat_example")).toEqual({
      success: true,
      type: "organization",
    });
  });
});
