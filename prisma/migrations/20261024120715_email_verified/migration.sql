-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6);

-- Accounts that already exist and are active were created by hand or by the seed before
-- verification existed; treat their email as verified.
UPDATE "users" SET "email_verified_at" = "created_at"
WHERE "status" = 'ACTIVE' AND "email" IS NOT NULL;

-- A verified email needs an email.
ALTER TABLE "users" ADD CONSTRAINT "users_email_verified_needs_email"
  CHECK ("email_verified_at" IS NULL OR "email" IS NOT NULL);
