import { afterEach, describe, expect, it } from "vitest";
import { ChannelEventCryptoService } from "./channel-event-crypto.service";

const KEY = "11".repeat(32);

describe("ChannelEventCryptoService", () => {
  const originalKey = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
  const originalVersion = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    else process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = originalKey;
    if (originalVersion === undefined) delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V;
    else process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V = originalVersion;
  });

  it("fails closed instead of persisting plaintext when no key is configured", () => {
    delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    const crypto = new ChannelEventCryptoService();
    expect(() =>
      crypto.encrypt({ text: "secret" }, { appId: "app-a", eventId: "event-a", rowId: "row-a" }),
    ).toThrow("encryption unavailable");
  });

  it("binds ciphertext to app, event, row, and format metadata", () => {
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = KEY;
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V = "1";
    const crypto = new ChannelEventCryptoService();
    const encrypted = crypto.encrypt(
      { text: "secret" },
      { appId: "app-a", eventId: "event-a", rowId: "row-a" },
    );
    expect(
      crypto.decrypt(encrypted.encryptedPayload, encrypted.payloadKeyVersion, {
        appId: "app-a",
        eventId: "event-a",
        rowId: "row-a",
        formatVersion: encrypted.payloadFormatVersion,
      }),
    ).toEqual({ text: "secret" });

    for (const context of [
      { appId: "app-b", eventId: "event-a", rowId: "row-a", formatVersion: 1 },
      { appId: "app-a", eventId: "event-b", rowId: "row-a", formatVersion: 1 },
      { appId: "app-a", eventId: "event-a", rowId: "row-b", formatVersion: 1 },
      { appId: "app-a", eventId: "event-a", rowId: "row-a", formatVersion: 2 },
    ]) {
      expect(() =>
        crypto.decrypt(encrypted.encryptedPayload, encrypted.payloadKeyVersion, context),
      ).toThrow("payload unavailable");
    }
  });

  it("rejects ciphertext and authentication-tag tampering", () => {
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = KEY;
    const crypto = new ChannelEventCryptoService();
    const encrypted = crypto.encrypt(
      { text: "secret" },
      { appId: "app-a", eventId: "event-a", rowId: "row-a" },
    );
    const envelope = JSON.parse(encrypted.encryptedPayload);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() =>
      crypto.decrypt(JSON.stringify(envelope), 1, {
        appId: "app-a",
        eventId: "event-a",
        rowId: "row-a",
        formatVersion: 1,
      }),
    ).toThrow("payload unavailable");
  });
});
