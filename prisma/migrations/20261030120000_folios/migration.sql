-- CreateEnum
CREATE TYPE "folio_kind" AS ENUM ('GUEST', 'HOUSE', 'PAYMASTER', 'EVENT', 'POS');

-- CreateEnum
CREATE TYPE "folio_status" AS ENUM ('OPEN', 'SETTLED', 'TRANSFERRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "line_kind" AS ENUM ('CHARGE', 'TAX', 'DISCOUNT', 'REVERSAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'DEPOSIT_APPLY', 'WRITE_OFF');

-- CreateTable
CREATE TABLE "folios" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "folio_kind" NOT NULL DEFAULT 'GUEST',
    "reservation_id" UUID,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "folio_status" NOT NULL DEFAULT 'OPEN',
    "credit_limit_minor" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_windows" (
    "id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "payer_type" TEXT NOT NULL,
    "payer_guest_id" UUID,
    "company_id" UUID,

    CONSTRAINT "folio_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "revenue_group" "revenue_group",
    "revenue_code_id" UUID,
    "window_id" UUID NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "window_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "line_kind" NOT NULL,
    "revenue_code_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_amount_minor" BIGINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "parent_line_id" UUID,
    "reverses_line_id" UUID,
    "tax_rule_version_id" UUID,
    "source_type" TEXT,
    "source_id" TEXT,
    "posted_by_id" UUID,
    "shift_id" UUID,
    "approval_request_id" UUID,
    "reason" TEXT,

    CONSTRAINT "folio_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "folios_reservation_id_idx" ON "folios"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "folios_property_id_number_key" ON "folios"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "folios_property_id_id_key" ON "folios"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "folio_windows_folio_id_number_key" ON "folio_windows"("folio_id", "number");

-- CreateIndex
CREATE INDEX "routing_rules_folio_id_idx" ON "routing_rules"("folio_id");

-- CreateIndex
CREATE UNIQUE INDEX "folio_lines_reverses_line_id_key" ON "folio_lines"("reverses_line_id");

-- CreateIndex
CREATE INDEX "folio_lines_folio_id_idx" ON "folio_lines"("folio_id");

-- CreateIndex
CREATE INDEX "folio_lines_property_id_business_date_idx" ON "folio_lines"("property_id", "business_date");

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_folio_id_fkey" FOREIGN KEY ("property_id", "folio_id") REFERENCES "folios"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_windows" ADD CONSTRAINT "folio_windows_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_windows" ADD CONSTRAINT "folio_windows_payer_guest_id_fkey" FOREIGN KEY ("payer_guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_windows" ADD CONSTRAINT "folio_windows_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "folio_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_revenue_code_id_fkey" FOREIGN KEY ("revenue_code_id") REFERENCES "revenue_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_property_id_folio_id_fkey" FOREIGN KEY ("property_id", "folio_id") REFERENCES "folios"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "folio_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_property_id_revenue_code_id_fkey" FOREIGN KEY ("property_id", "revenue_code_id") REFERENCES "revenue_codes"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_tax_rule_version_id_fkey" FOREIGN KEY ("tax_rule_version_id") REFERENCES "tax_rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_parent_line_id_fkey" FOREIGN KEY ("parent_line_id") REFERENCES "folio_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_reverses_line_id_fkey" FOREIGN KEY ("reverses_line_id") REFERENCES "folio_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tab 3 constraint 4 / M4 rule 1: folio lines are append-only (corrections are reversals).
CREATE TRIGGER folio_lines_append_only BEFORE UPDATE OR DELETE ON "folio_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Tab 3 constraint 5: a closed business day takes no new lines.
CREATE OR REPLACE FUNCTION forbid_closed_day() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM business_days
             WHERE property_id = NEW.property_id
               AND date = NEW.business_date
               AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'BUSINESS_DAY_CLOSED';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER folio_lines_open_day BEFORE INSERT ON "folio_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_day();

-- Lines: a tax line has its charge and version; a reversal points at what it reverses.
ALTER TABLE "folio_lines"
  ADD CONSTRAINT "folio_lines_tax_check" CHECK (
    "kind" <> 'TAX' OR ("parent_line_id" IS NOT NULL AND "tax_rule_version_id" IS NOT NULL)),
  ADD CONSTRAINT "folio_lines_reversal_check" CHECK (
    ("kind" = 'REVERSAL') = ("reverses_line_id" IS NOT NULL)),
  ADD CONSTRAINT "folio_lines_quantity_check" CHECK ("quantity" > 0);

-- Window 1 is the first; payer is the guest or a company.
ALTER TABLE "folio_windows"
  ADD CONSTRAINT "folio_windows_number_check" CHECK ("number" BETWEEN 1 AND 8),
  ADD CONSTRAINT "folio_windows_payer_check" CHECK (
    ("payer_type" = 'GUEST' AND "company_id" IS NULL)
    OR ("payer_type" = 'COMPANY' AND "company_id" IS NOT NULL));

-- A rule routes a revenue group or one code, not both.
ALTER TABLE "routing_rules"
  ADD CONSTRAINT "routing_rules_target_check" CHECK (
    ("revenue_group" IS NULL) <> ("revenue_code_id" IS NULL));

-- One guest folio per stay.
CREATE UNIQUE INDEX "stays_folio_id_key" ON "stays" ("folio_id") WHERE "folio_id" IS NOT NULL;
