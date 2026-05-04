import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { env } from "../shared/env";

/**
 * SecretsService — encrypts and decrypts sensitive data at rest.
 *
 * All secrets (API keys, service account files, OAuth tokens, service secrets)
 * are encrypted with AES-256-GCM before storage in PostgreSQL.
 *
 * Encryption key comes from PLATOS_ENCRYPTION_KEY env var (32-byte hex).
 * If not set, generates a random key and warns (dev mode only).
 *
 * Supports:
 * - String secrets (API keys, tokens)
 * - File secrets (GCP service account JSON, certificates)
 * - Secret rotation (re-encrypt with new key)
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class SecretsService {
  private encryptionKey: Buffer;

  constructor() {
    const keyHex = env.PLATOS_ENCRYPTION_KEY;
    const keyOk = typeof keyHex === "string" && keyHex.length === 64 && /^[0-9a-fA-F]{64}$/.test(keyHex);

    if (keyOk) {
      this.encryptionKey = Buffer.from(keyHex, "hex");
      return;
    }

    // EOBD.3 — refuse to boot in production with missing/malformed key.
    // A restart loop under the ephemeral-random fallback would cycle
    // through distinct keys and make every encrypted row persistently
    // unreadable. Production must supply a stable 64-hex-char key.
    if (env.NODE_ENV === "production") {
      throw new Error(
        "[Platos Secrets] PLATOS_ENCRYPTION_KEY is required in production. " +
          "Value must be exactly 64 hex characters (32 bytes). " +
          "Generate one with: openssl rand -hex 32",
      );
    }

    // Dev / test — generate ephemeral key but print it so a dev can pin
    // it in their .env and avoid the ephemeral-churn footgun.
    this.encryptionKey = crypto.randomBytes(32);
    const generatedHex = this.encryptionKey.toString("hex");
    console.warn(
      "[Platos Secrets] WARNING: No valid PLATOS_ENCRYPTION_KEY set. Generated ephemeral key. " +
        "Secrets encrypted under this key will NOT survive restart. " +
        `Pin this value in .env to persist: PLATOS_ENCRYPTION_KEY=${generatedHex}`,
    );
  }

  /**
   * Encrypt a string. Returns base64-encoded ciphertext with IV + auth tag prepended.
   * Format: base64(IV + authTag + ciphertext)
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Pack: IV (16) + authTag (16) + ciphertext
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return packed.toString("base64");
  }

  /**
   * Decrypt a base64-encoded ciphertext.
   */
  decrypt(ciphertext: string): string {
    const packed = Buffer.from(ciphertext, "base64");
    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf-8");
  }

  /**
   * Encrypt a file (e.g., GCP service account JSON).
   * Returns the encrypted content as base64.
   */
  encryptFile(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    return this.encrypt(content);
  }

  /**
   * Decrypt file content back to string.
   */
  decryptToString(encrypted: string): string {
    return this.decrypt(encrypted);
  }

  /**
   * Decrypt file content and write to a temp file.
   * Returns the temp file path. Caller must delete after use.
   */
  decryptToTempFile(encrypted: string, filename: string = "secret.json"): string {
    const content = this.decrypt(encrypted);
    const tmpDir = env.PLATOS_SECRETS_TMP_DIR || "/tmp/platos-secrets";
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = path.join(tmpDir, `${crypto.randomBytes(8).toString("hex")}-${filename}`);
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    return tmpPath;
  }

  /**
   * Delete a temp secret file.
   */
  cleanupTempFile(tmpPath: string): void {
    try {
      if (fs.existsSync(tmpPath)) {
        // Overwrite with zeros before deleting
        const size = fs.statSync(tmpPath).size;
        fs.writeFileSync(tmpPath, Buffer.alloc(size, 0));
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best effort cleanup
    }
  }

  /**
   * Validate that the encryption key is properly configured.
   */
  isProductionReady(): boolean {
    return !!env.PLATOS_ENCRYPTION_KEY && env.PLATOS_ENCRYPTION_KEY.length === 64;
  }
}
