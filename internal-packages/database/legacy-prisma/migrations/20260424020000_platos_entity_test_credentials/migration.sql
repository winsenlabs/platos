-- PIFSP-3 (Deliverable 9) — per-entity test credentials stash used by the
-- dashboard "Test" button + PIFSP-4 Postman-style test sheet. Never used
-- in production tool dispatch (HMAC-signed with serviceSecret there).
--
-- TEXT rather than JSONB because the payload is an opaque base64 envelope
-- produced by MessageCryptoService.encryptJsonField — not indexable JSON.
-- Reader decrypts before parsing.
--
-- Idempotent: IF NOT EXISTS keeps re-runs safe in environments where the
-- column was pre-applied by hand.
ALTER TABLE "PlatosConnectedEntity"
  ADD COLUMN IF NOT EXISTS "testCredentials" TEXT NULL;
