#!/usr/bin/env tsx

/**
 * M3 re-encrypt sweep — the deferred half.
 *
 * Background
 * ----------
 * OAuth entity tokens (PlatosMcpOidcSession.entityAccessToken /
 * .entityRefreshToken) are now WRITTEN through SecretsService under
 * PLATOS_ENCRYPTION_KEY (fail-closed). Legacy rows exist in three shapes,
 * all indistinguishable by wire format — every one is base64(iv|tag|ct):
 *
 *   (A) NEW-KEY      — encrypted under PLATOS_ENCRYPTION_KEY (current).
 *   (B) MESSAGE-KEY  — encrypted (pre-M3) under PLATOS_MESSAGE_ENCRYPTION_KEY.
 *   (C) PLAINTEXT    — stored raw when PLATOS_MESSAGE_ENCRYPTION_KEY was unset
 *                      under the old fail-open behaviour.
 *
 * OAuthController.decryptEntityToken() dual-reads (A) then (B) then treats the
 * value as (C) passthrough. This sweep migrates (B) and (C) to (A) so that
 * dual-read (legacyDecryptEntityTokenWithMessageKey) can eventually be deleted.
 *
 * THE CRUX — no schema marker, so which key decrypts is the ONLY signal.
 * ---------------------------------------------------------------------
 * AES-256-GCM's 128-bit authentication tag IS the marker. A ciphertext
 * authenticates under exactly the key that produced it; the probability of a
 * ciphertext authenticating under the wrong key is ~2^-128. So:
 *
 *   1. New-key GCM decrypt succeeds  -> row is (A). SKIP. (idempotency + never
 *      corrupt an already-migrated row.)
 *   2. Else message-key GCM decrypt succeeds -> row is (B). Plaintext recovered,
 *      authenticated. Re-encrypt under the new key. UPDATE.
 *   3. Else BOTH fail. Now separate (C) plaintext from an UNREADABLE ciphertext
 *      (e.g. operator supplied the wrong PLATOS_ENCRYPTION_KEY, or the row is
 *      corrupt) WITHOUT a marker:
 *        - If the value is not pure base64, or is too short to hold iv|tag
 *          (decoded < 32 bytes) -> it cannot be one of our ciphertexts ->
 *          it is definitively (C) plaintext. Re-encrypt. UPDATE.
 *          (Real OIDC/Google/JWT access tokens contain '.', '-' or '_', which
 *          are outside the base64 alphabet, so they land here cleanly.)
 *        - Else it is pure base64 >= 32 bytes that neither key authenticates ->
 *          AMBIGUOUS. It could be a valid new-key row under a mis-supplied key,
 *          so re-encrypting would DOUBLE-WRAP and corrupt a good row. We refuse:
 *          SKIP and record it in the report for human review. Never write.
 *
 * This guarantees: message-key and new-key rows are never mis-handled (GCM),
 * plaintext is only rewritten when positively identified, and a mis-configured
 * new key can only cause SKIPs — never corruption. Fully idempotent: a second
 * run re-reads migrated rows via branch 1 and skips them.
 *
 * The encrypt/decrypt format below is byte-identical to
 * apps/agent/src/auth/secrets.service.ts (new key) and to
 * OAuthController.legacyDecryptEntityTokenWithMessageKey (message key), so the
 * rows this sweep writes are read back by decryptEntityToken()'s branch 1.
 *
 * USAGE
 * -----
 *   Dry-run (default, no writes — prints a full classification report):
 *     PLATOS_ENCRYPTION_KEY=<64hex> \
 *     PLATOS_MESSAGE_ENCRYPTION_KEY=<64hex|32utf8> \
 *     tsx scripts/reencrypt-entity-oauth-tokens.ts "<postgresUrl>"
 *
 *   Execute (writes re-encrypted rows):
 *     PLATOS_ENCRYPTION_KEY=<64hex> \
 *     PLATOS_MESSAGE_ENCRYPTION_KEY=<64hex|32utf8> \
 *     tsx scripts/reencrypt-entity-oauth-tokens.ts "<postgresUrl>" --execute
 *
 * PLATOS_MESSAGE_ENCRYPTION_KEY is optional: if unset, branch 2 is disabled and
 * only plaintext (C) rows migrate — matching the runtime dual-read, which also
 * treats every row as plaintext passthrough when the message key is absent.
 */

import * as crypto from "node:crypto";
import { PrismaClient } from "@platos/database";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH; // 32 bytes minimum for iv|tag

// ── Key loading ────────────────────────────────────────────────────────────

function loadNewKey(): Buffer {
  const keyHex = process.env.PLATOS_ENCRYPTION_KEY;
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "PLATOS_ENCRYPTION_KEY is required and must be exactly 64 hex characters " +
        "(32 bytes). Generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(keyHex, "hex");
}

// Mirror of legacyDecryptEntityTokenWithMessageKey's key derivation:
// 64-hex OR a raw 32-byte utf8 string. null => no legacy key configured.
function loadMessageKey(): Buffer | null {
  const keyHex = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
  if (!keyHex) return null;
  if (keyHex.length === 64) return Buffer.from(keyHex, "hex");
  if (Buffer.byteLength(keyHex, "utf8") === 32) return Buffer.from(keyHex, "utf8");
  return null;
}

// ── Crypto (byte-identical to SecretsService + legacy read path) ─────────────

function encryptNew(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

// Authenticated decrypt. Returns null on ANY failure (bad key, bad tag, short).
function tryDecrypt(ciphertext: string, key: Buffer): string | null {
  try {
    const packed = Buffer.from(ciphertext, "base64");
    if (packed.length < HEADER_LENGTH) return null;
    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, HEADER_LENGTH);
    const enc = packed.subarray(HEADER_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Could this string possibly be one of our base64(iv|tag|ct) ciphertexts?
// Pure standard-base64 alphabet, length multiple of 4, and decodes to at least
// iv|tag. A real OAuth token that contains '.', '-', '_' or is short fails here
// and is therefore provably plaintext.
function looksLikeCiphertext(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").length >= HEADER_LENGTH;
}

type Classification = "new" | "message" | "plaintext" | "ambiguous";

function classify(
  value: string,
  newKey: Buffer,
  messageKey: Buffer | null,
): { kind: Classification; plaintext?: string } {
  // 1. Already new-key encrypted -> skip (idempotent, never corrupt).
  if (tryDecrypt(value, newKey) !== null) return { kind: "new" };
  // 2. Message-key encrypted -> authenticated legacy ciphertext.
  if (messageKey) {
    const p = tryDecrypt(value, messageKey);
    if (p !== null) return { kind: "message", plaintext: p };
  }
  // 3. Neither key authenticates. Separate plaintext from unreadable ciphertext.
  if (!looksLikeCiphertext(value)) return { kind: "plaintext", plaintext: value };
  return { kind: "ambiguous" };
}

// ── Sweep ────────────────────────────────────────────────────────────────────

interface FieldStat {
  new: number;
  message: number;
  plaintext: number;
  ambiguous: number;
}

function emptyStat(): FieldStat {
  return { new: 0, message: 0, plaintext: 0, ambiguous: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const postgresUrl = args.find((a) => !a.startsWith("--"));

  if (!postgresUrl) {
    console.error(
      "Usage: tsx scripts/reencrypt-entity-oauth-tokens.ts <postgresUrl> [--execute]",
    );
    console.error("");
    console.error("Env: PLATOS_ENCRYPTION_KEY (required, 64 hex)");
    console.error("     PLATOS_MESSAGE_ENCRYPTION_KEY (optional legacy key)");
    process.exit(1);
  }

  const newKey = loadNewKey();
  const messageKey = loadMessageKey();

  console.log(execute ? "⚠️  EXECUTE MODE — rows will be UPDATED\n" : "🔍 DRY RUN — no writes\n");
  console.log(`legacy message key: ${messageKey ? "configured" : "NOT configured (branch 2 disabled)"}\n`);

  const prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } });

  const accessStat = emptyStat();
  const refreshStat = emptyStat();
  const ambiguousRows: { id: string; field: string }[] = [];
  let scanned = 0;
  let updated = 0;

  try {
    // Page through only rows that actually carry a token, keyset by id.
    let cursor: string | undefined;
    const PAGE = 500;
    for (;;) {
      const rows: Array<{
        id: string;
        entityAccessToken: string | null;
        entityRefreshToken: string | null;
      }> = await prisma.platosMcpOidcSession.findMany({
        where: {
          OR: [{ entityAccessToken: { not: null } }, { entityRefreshToken: { not: null } }],
        },
        select: { id: true, entityAccessToken: true, entityRefreshToken: true },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        scanned++;
        const patch: { entityAccessToken?: string; entityRefreshToken?: string } = {};

        for (const field of ["entityAccessToken", "entityRefreshToken"] as const) {
          const value = row[field];
          if (!value) continue;
          const stat = field === "entityAccessToken" ? accessStat : refreshStat;
          const { kind, plaintext } = classify(value, newKey, messageKey);
          stat[kind]++;
          if (kind === "message" || kind === "plaintext") {
            // plaintext is authenticated (message) or provably raw (plaintext).
            patch[field] = encryptNew(plaintext as string, newKey);
          } else if (kind === "ambiguous") {
            ambiguousRows.push({ id: row.id, field });
          }
        }

        if (Object.keys(patch).length > 0) {
          if (execute) {
            await prisma.platosMcpOidcSession.update({ where: { id: row.id }, data: patch });
          }
          updated++;
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const dump = (label: string, s: FieldStat) =>
    console.log(
      `${label}: new(skip)=${s.new}  message→re-enc=${s.message}  ` +
        `plaintext→enc=${s.plaintext}  AMBIGUOUS(skip)=${s.ambiguous}`,
    );

  console.log(`\nScanned ${scanned} session row(s).`);
  dump("  access ", accessStat);
  dump("  refresh", refreshStat);
  console.log(`\n${execute ? "Updated" : "Would update"} ${updated} row(s).`);

  if (ambiguousRows.length > 0) {
    console.log(
      `\n⚠️  ${ambiguousRows.length} AMBIGUOUS field(s) — pure base64, ≥32 bytes, ` +
        `neither key authenticates. NOT written. Investigate before deleting the ` +
        `dual-read (likely a wrong PLATOS_ENCRYPTION_KEY or corrupt rows):`,
    );
    for (const a of ambiguousRows.slice(0, 50)) console.log(`   ${a.id}  ${a.field}`);
    if (ambiguousRows.length > 50) console.log(`   … +${ambiguousRows.length - 50} more`);
    // Non-zero exit so the dual-read is NOT deleted while ambiguity remains.
    process.exitCode = 2;
  } else {
    console.log("\n✅ No ambiguous rows. Once message→ and plaintext→ counts reach 0 on a");
    console.log("   clean run, the legacy dual-read can be safely removed.");
  }
}

main().catch((err) => {
  console.error("sweep failed:", err);
  process.exit(1);
});
