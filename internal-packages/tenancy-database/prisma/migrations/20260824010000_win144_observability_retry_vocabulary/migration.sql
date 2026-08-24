-- WIN-144: this is a forward rename. The initial migration remains frozen so
-- deployed databases and clean installs traverse the same history.
ALTER TABLE "public"."ObservabilityOutbox"
  RENAME COLUMN "attempts" TO "retryCount";
