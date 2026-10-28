-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "threshold_minor" BIGINT,
    "threshold_bps" INTEGER,
    "approver_role_ids" UUID[],
    "expiry_minutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "reason" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_channel" TEXT,
    "decision_note" TEXT,
    "result_ref" TEXT,
    "otp_hash" TEXT,
    "otp_expires_at" TIMESTAMPTZ(6),
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_policies_property_id_action_key" ON "approval_policies"("property_id", "action");

-- CreateIndex
CREATE INDEX "approval_requests_property_id_status_idx" ON "approval_requests"("property_id", "status");

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL (T-022)
ALTER TABLE "approval_policies"
  ADD CONSTRAINT "approval_policies_threshold_minor_check" CHECK ("threshold_minor" IS NULL OR "threshold_minor" >= 0),
  ADD CONSTRAINT "approval_policies_threshold_bps_check" CHECK ("threshold_bps" IS NULL OR "threshold_bps" BETWEEN 0 AND 10000),
  -- Up to a week; rule 3 defaults are 30 minutes and 48 hours.
  ADD CONSTRAINT "approval_policies_expiry_check" CHECK ("expiry_minutes" BETWEEN 1 AND 10080);

ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_channel_check" CHECK ("decision_channel" IS NULL OR "decision_channel" IN ('APP', 'WHATSAPP_OTP')),
  -- Rule 4: the requester cannot approve their own request.
  ADD CONSTRAINT "approval_requests_not_self_check" CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id"),
  -- A decision has a decider and a time; a pending request has neither.
  ADD CONSTRAINT "approval_requests_decision_check" CHECK (
    ("status" IN ('PENDING', 'EXPIRED') AND "decided_by_id" IS NULL AND "decided_at" IS NULL)
    OR ("status" NOT IN ('PENDING', 'EXPIRED') AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
  ADD CONSTRAINT "approval_requests_otp_attempts_check" CHECK ("otp_attempts" BETWEEN 0 AND 5),
  ADD CONSTRAINT "approval_requests_amount_check" CHECK ("amount_minor" IS NULL OR "amount_minor" >= 0);

-- The expiry job looks for pending requests past their expiry.
CREATE INDEX "approval_requests_pending_expiry_idx" ON "approval_requests" ("expires_at") WHERE "status" = 'PENDING';
