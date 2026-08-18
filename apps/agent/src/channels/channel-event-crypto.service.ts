import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const DOMAIN = "platos:channel-event-inbox:v1";
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;

export interface ChannelEventCryptoContext {
  appId: string;
  eventId: string;
  rowId: string;
  formatVersion: number;
}

export interface EncryptedChannelEvent {
  encryptedPayload: string;
  payloadFormatVersion: number;
  payloadKeyVersion: number;
}

interface PayloadEnvelope {
  nonce: string;
  ciphertext: string;
  authTag: string;
}

function decodeKey(value: string | undefined): Buffer | null {
  return value && /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

function configuredVersion(): number {
  const value = Number(process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V ?? "1");
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

/** Mandatory, domain-separated encryption for verified provider event payloads. */
@Injectable()
export class ChannelEventCryptoService {
  private readonly activeKeyVersion = configuredVersion();
  private readonly activeRootKey = decodeKey(process.env.PLATOS_MESSAGE_ENCRYPTION_KEY);

  encrypt(value: unknown, input: Omit<ChannelEventCryptoContext, "formatVersion">): EncryptedChannelEvent {
    if (!this.activeRootKey) throw new Error("channel event encryption unavailable");
    const context = { ...input, formatVersion: FORMAT_VERSION };
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.deriveKey(this.activeRootKey), nonce);
    cipher.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const envelope: PayloadEnvelope = {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
    return {
      encryptedPayload: JSON.stringify(envelope),
      payloadFormatVersion: FORMAT_VERSION,
      payloadKeyVersion: this.activeKeyVersion,
    };
  }

  decrypt(encryptedPayload: string, keyVersion: number, context: ChannelEventCryptoContext): unknown {
    if (context.formatVersion !== FORMAT_VERSION) {
      throw new Error("channel event payload unavailable");
    }
    const rootKey =
      keyVersion === this.activeKeyVersion
        ? this.activeRootKey
        : decodeKey(process.env[`PLATOS_MESSAGE_ENCRYPTION_KEY_V${keyVersion}`]);
    if (!rootKey) throw new Error("channel event encryption unavailable");
    let envelope: PayloadEnvelope;
    try {
      envelope = JSON.parse(encryptedPayload) as PayloadEnvelope;
      if (!envelope.nonce || !envelope.ciphertext || !envelope.authTag) throw new Error();
    } catch {
      throw new Error("channel event payload unavailable");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.deriveKey(rootKey),
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("channel event payload unavailable");
    }
  }

  private deriveKey(rootKey: Buffer): Buffer {
    const salt = createHash("sha256").update(`${DOMAIN}:salt`).digest();
    return Buffer.from(hkdfSync("sha256", rootKey, salt, Buffer.from(`${DOMAIN}:key`), 32));
  }

  private aad(context: ChannelEventCryptoContext): Buffer {
    return Buffer.from(
      JSON.stringify([
        DOMAIN,
        context.formatVersion,
        context.appId,
        context.eventId,
        context.rowId,
      ]),
      "utf8",
    );
  }
}
