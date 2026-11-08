-- CreateTable
CREATE TABLE "referral_partners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "contact_name" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "payout_details_enc" BYTEA,
    "commission_bps" INTEGER NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referrals" (
    "organisation_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "tied_at" TIMESTAMPTZ(6) NOT NULL,
    "first_paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "partner_referrals_pkey" PRIMARY KEY ("organisation_id")
);

-- CreateTable
CREATE TABLE "partner_commissions" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "commission_bps" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "earned_at" TIMESTAMPTZ(6) NOT NULL,
    "payout_id" UUID,

    CONSTRAINT "partner_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payouts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "paid_by_id" UUID NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_changes" (
    "id" BIGSERIAL NOT NULL,
    "partner_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partner_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_partners_email_key" ON "referral_partners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "referral_partners_code_key" ON "referral_partners"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_partners_user_id_key" ON "referral_partners"("user_id");

-- CreateIndex
CREATE INDEX "partner_referrals_partner_id_idx" ON "partner_referrals"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_commissions_invoice_id_key" ON "partner_commissions"("invoice_id");

-- CreateIndex
CREATE INDEX "partner_commissions_partner_id_earned_at_idx" ON "partner_commissions"("partner_id", "earned_at");

-- CreateIndex
CREATE INDEX "partner_payouts_partner_id_paid_at_idx" ON "partner_payouts"("partner_id", "paid_at");

-- CreateIndex
CREATE INDEX "partner_changes_partner_id_at_idx" ON "partner_changes"("partner_id", "at");

-- AddForeignKey
ALTER TABLE "referral_partners" ADD CONSTRAINT "referral_partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "referral_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "referral_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "partner_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "referral_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_paid_by_id_fkey" FOREIGN KEY ("paid_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_changes" ADD CONSTRAINT "partner_changes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "referral_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_changes" ADD CONSTRAINT "partner_changes_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "referral_partners"
  ADD CONSTRAINT "referral_partners_commission_bps_check" CHECK ("commission_bps" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "referral_partners_duration_months_check" CHECK ("duration_months" BETWEEN 1 AND 120);
ALTER TABLE "partner_commissions"
  ADD CONSTRAINT "partner_commissions_amount_check" CHECK ("amount_minor" > 0);
ALTER TABLE "partner_payouts"
  ADD CONSTRAINT "partner_payouts_amount_check" CHECK ("amount_minor" > 0);
