-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_last_used_step" BIGINT;

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MFA can only be on with a stored secret; time steps are never negative.
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_enabled_needs_secret"
  CHECK (NOT "mfa_enabled" OR "mfa_secret_enc" IS NOT NULL);
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_last_used_step_non_negative"
  CHECK ("mfa_last_used_step" IS NULL OR "mfa_last_used_step" >= 0);
