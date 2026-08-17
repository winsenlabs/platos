-- LAUNCH-12 — track the actual logged-in operator separately from the
-- (possibly Postman-simulated) `userId`. Operator always sees threads
-- they created, even when they ran the turn as a simulated user.
ALTER TABLE "PlatosAgentThread" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
