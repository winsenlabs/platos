-- Isolated supplemental-auth cutover fixture. Apply after legacy-core-seed.sql.
-- The v2 vectors use ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000.
-- Invalid rows are deliberate preflight/decrypt blockers and must not be used by
-- the guarded rehearsal fixture until a test removes the named blocker rows.

INSERT INTO "OrgMemberInvite"
  (id, token, email, role, "organizationId", "inviterId", "createdAt", "updatedAt")
VALUES
  ('cllegacyinvite0001', 'fixture-invite-token-admin', 'Admin.Invite@Example.COM', 'ADMIN',
   'cllegacyorg0001', 'cllegacyuser0001', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacyinvite0002', 'fixture-invite-token-member', 'member.invite@example.com', 'MEMBER',
   'cllegacyorg0001', 'cllegacyuser0001', '2025-01-02T00:00:00Z', '2025-01-03T00:00:00Z');

INSERT INTO "ImpersonationAuditLog"
  (id, action, "adminId", "targetId", "ipAddress", "createdAt")
VALUES
  ('cllegacyaudit0001', 'START', 'cllegacyuser0001', 'cllegacyuser0002', '192.0.2.10',
   '2025-01-03T00:00:00Z'),
  ('cllegacyaudit0002', 'STOP', 'cllegacyuser0001', 'cllegacyuser0002', NULL,
   '2025-01-03T00:15:00Z');

INSERT INTO "User"
  (id, email, "authenticationMethod", "authIdentifier", "displayName", admin,
   "createdAt", "updatedAt", "mfaEnabledAt")
VALUES
  ('cllegacyuser0003', 'pending@example.com', 'MAGIC_LINK', NULL, 'Pending MFA', false,
   '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z', NULL),
  ('cllegacyuser0004', 'null-reference@example.com', 'MAGIC_LINK', NULL, 'Null Reference', false,
   '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z', '2025-01-03T00:00:00Z'),
  ('cllegacyuser0005', 'missing-store@example.com', 'MAGIC_LINK', NULL, 'Missing Store', false,
   '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z', '2025-01-03T00:00:00Z'),
  ('cllegacyuser0006', 'undecryptable@example.com', 'MAGIC_LINK', NULL, 'Undecryptable', false,
   '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z', '2025-01-03T00:00:00Z'),
  ('cllegacyuser0007', 'non-base32@example.com', 'MAGIC_LINK', NULL, 'Non Base32', false,
   '2025-01-01T00:00:00Z', '2025-01-04T00:00:00Z', '2025-01-03T00:00:00Z');

INSERT INTO "SecretReference" (id, key, provider, "createdAt", "updatedAt")
VALUES
  ('cllegacymfaref0001', 'mfa:fixture:enabled-v1', 'DATABASE',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  ('cllegacymfaref0003', 'mfa:fixture:pending-v2', 'DATABASE',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  ('cllegacymfaref0005', 'mfa:fixture:missing-store', 'DATABASE',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  ('cllegacymfaref0006', 'mfa:fixture:undecryptable-v2', 'DATABASE',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  ('cllegacymfaref0007', 'mfa:fixture:non-base32-source', 'DATABASE',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z');

-- enabled-v1: raw legacy bytes include 0, 1, 8, and 9 and must be Base32-encoded,
-- never interpreted as already-Base32 input.
INSERT INTO "SecretStore" (key, value, version, "createdAt", "updatedAt")
VALUES
  ('mfa:fixture:enabled-v1', '{"secret":"A1B2C3D4E5F6G7H8I9J0K1L2"}'::jsonb, '1',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  -- pending-v2: valid strict AES-256-GCM hex envelope.
  ('mfa:fixture:pending-v2',
   '{"ciphertext":"145b8efd0a6a83d262c95077d57927164004d189feb885396eccd82e4d4a9a4f70655d5556","nonce":"222222222222222222222222","tag":"05075459e90ef725f42f5777a653c986"}'::jsonb,
   '2', '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  -- undecryptable-v2: the final tag nibble is deliberately modified.
  ('mfa:fixture:undecryptable-v2',
   '{"ciphertext":"7eccd4e527fe5477b4b904f5c954be43cf3becb0fcf6347bdf74981918b7f2800947983eff","nonce":"333333333333333333333333","tag":"2aa593dcd47bad1503f4f80fae5799e7"}'::jsonb,
   '2', '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z'),
  -- non-base32-source: neither canonical Base32 nor the exact 24-byte legacy raw format.
  ('mfa:fixture:non-base32-source', '{"secret":"lowercase-is-not-legacy"}'::jsonb, '1',
   '2025-01-02T00:00:00Z', '2025-01-05T00:00:00Z');

UPDATE "User" SET "mfaSecretReferenceId" = 'cllegacymfaref0001',
                  "mfaEnabledAt" = '2025-01-03T00:00:00Z'
 WHERE id = 'cllegacyuser0001';
-- disabled-null-reference
UPDATE "User" SET "mfaSecretReferenceId" = NULL, "mfaEnabledAt" = NULL
 WHERE id = 'cllegacyuser0002';
UPDATE "User" SET "mfaSecretReferenceId" = 'cllegacymfaref0003'
 WHERE id = 'cllegacyuser0003';
-- enabled-null-reference is intentionally inconsistent and must fail preflight.
UPDATE "User" SET "mfaSecretReferenceId" = NULL
 WHERE id = 'cllegacyuser0004';
UPDATE "User" SET "mfaSecretReferenceId" = 'cllegacymfaref0005'
 WHERE id = 'cllegacyuser0005';
UPDATE "User" SET "mfaSecretReferenceId" = 'cllegacymfaref0006'
 WHERE id = 'cllegacyuser0006';
UPDATE "User" SET "mfaSecretReferenceId" = 'cllegacymfaref0007'
 WHERE id = 'cllegacyuser0007';

-- no-recovery-code-cutover: inherited recovery hashes are deliberately present
-- but supplemental auth transforms must create zero OperatorMfaRecoveryCode rows.
INSERT INTO "MfaBackupCode" (id, code, "userId", "createdAt", "updatedAt")
VALUES ('cllegacybackup0001', 'fixture-legacy-one-way-code-digest', 'cllegacyuser0001',
        '2025-01-03T00:00:00Z', '2025-01-03T00:00:00Z');
