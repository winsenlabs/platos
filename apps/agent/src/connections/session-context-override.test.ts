/**
 * The WS `sessionContextOverride` identity gate.
 *
 * The sibling knob on the same socket payload, `postmanUserId`, has always
 * required an OWNER/ADMIN OrgMember lookup. The identity half of this one sat
 * outside that gate, so any authenticated client could send
 * `{ user: { name, email } }` and have it copied verbatim onto the turn — keyed
 * to the ATTACKER'S end_user_id, which means erasing the person actually named
 * in the row never reaches it.
 */

import { describe, expect, test } from "vitest";
import { assertsIdentity, stripAssertedIdentity } from "./session-context-override";

describe("recognising an identity claim", () => {
  test("catches both spellings the context bag accepts", () => {
    // `{{user.name}}` resolves through a dotted lookup as well as the nested
    // object, so a gate that only knew one of them would be a gate with a door
    // next to it.
    expect(assertsIdentity({ user: { name: "Mallory" } })).toBe(true);
    expect(assertsIdentity({ user: { email: "victim@example.test" } })).toBe(true);
    expect(assertsIdentity({ "user.name": "Mallory" })).toBe(true);
    expect(assertsIdentity({ "user.email": "victim@example.test" })).toBe(true);
  });

  test("an override with no identity claim is not gated", () => {
    // The common Postman case: timezone, entity narrowing, declared keys. None
    // of it is a claim about who somebody is, so none of it costs a DB lookup.
    expect(assertsIdentity(undefined)).toBe(false);
    expect(assertsIdentity({})).toBe(false);
    expect(assertsIdentity({ user_timezone: "Asia/Kolkata", entity_ids: ["e1"] })).toBe(false);
    expect(assertsIdentity({ user: { id: "u-1", current_time: "now" } })).toBe(false);
  });
});

describe("stripping an unsigned identity claim", () => {
  test("removes the claim and keeps everything else in the bag", () => {
    const { sanitized, removed } = stripAssertedIdentity({
      user: { name: "Mallory", email: "victim@example.test", id: "u-1" },
      "user.name": "Mallory",
      user_timezone: "Asia/Kolkata",
      entity_ids: ["e1"],
    });
    expect(sanitized).toEqual({
      user: { id: "u-1" },
      user_timezone: "Asia/Kolkata",
      entity_ids: ["e1"],
    });
    expect(removed.sort()).toEqual(["user.email", "user.name", "user.name"].sort());
  });

  test("drops a `user` object the strip emptied rather than leaving a blank one", () => {
    // The override is merged ON TOP of the JWT-lifted sessionContext, so an
    // empty `user: {}` would blank out the signed visitor identity the prompt
    // resolver depends on — a denial-of-identity where the forgery used to be.
    const { sanitized } = stripAssertedIdentity({ user: { name: "Mallory" } });
    expect(sanitized).toEqual({});
    expect("user" in sanitized).toBe(false);
  });

  test("leaves a bag that asserts nothing untouched", () => {
    const bag = { user_timezone: "UTC", user: { id: "u-1" } };
    expect(stripAssertedIdentity(bag)).toEqual({ sanitized: bag, removed: [] });
  });

  test("does not mutate the caller's bag", () => {
    const bag = { user: { name: "Mallory", id: "u-1" } };
    stripAssertedIdentity(bag);
    expect(bag.user.name).toBe("Mallory");
  });
});
