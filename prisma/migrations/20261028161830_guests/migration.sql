-- CreateEnum
CREATE TYPE "company_kind" AS ENUM ('COMPANY', 'TRAVEL_AGENT', 'EVENT_CLIENT');

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "nationality" CHAR(2),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_at" TIMESTAMPTZ(6),
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "do_not_rent" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "kind" "company_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "contacts" JSONB NOT NULL DEFAULT '[]',
    "tax_id" TEXT,
    "credit_limit_minor" BIGINT,
    "payment_terms_days" INTEGER,
    "commission_bps" INTEGER,
    "billing_instructions" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guests_organisation_id_phone_idx" ON "guests"("organisation_id", "phone");

-- CreateIndex
CREATE INDEX "guests_organisation_id_email_idx" ON "guests"("organisation_id", "email");

-- CreateIndex
CREATE INDEX "guests_organisation_id_last_name_idx" ON "guests"("organisation_id", "last_name");

-- CreateIndex
CREATE INDEX "companies_organisation_id_name_idx" ON "companies"("organisation_id", "name");

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-043) ──────────────────────────────────────────

ALTER TABLE "guests"
  ADD CONSTRAINT "guests_not_merged_into_self_check" CHECK (merged_into_id <> id),
  ADD CONSTRAINT "guests_flag_reason_check"
    CHECK ((vip OR do_not_rent) = (flag_reason IS NOT NULL)),
  ADD CONSTRAINT "guests_consent_check" CHECK (NOT marketing_consent OR consent_at IS NOT NULL);

-- Name search (case-insensitive prefix on first, last and full name).
CREATE INDEX "guests_name_search_idx"
  ON "guests" ("organisation_id", lower(last_name), lower(first_name));

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_commission_check" CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 10000);
