-- CreateEnum
CREATE TYPE "pay_method" AS ENUM ('CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'CARD_ONLINE', 'VIRTUAL_ACCOUNT', 'MOBILE_MONEY', 'VOUCHER', 'AR_TRANSFER');

-- CreateEnum
CREATE TYPE "shift_status" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "cashier_shifts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "user_id" UUID,
    "outlet_id" UUID,
    "status" "shift_status" NOT NULL DEFAULT 'OPEN',
    "float_minor" BIGINT NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "signed_off_by_id" UUID,
    "variance_note" TEXT,

    CONSTRAINT "cashier_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_counts" (
    "id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "method" "pay_method" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "expected_minor" BIGINT NOT NULL,
    "counted_minor" BIGINT NOT NULL,
    "variance_minor" BIGINT NOT NULL,

    CONSTRAINT "cash_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_handovers" (
    "id" UUID NOT NULL,
    "from_shift_id" UUID NOT NULL,
    "to_user_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "cash_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leakage_alerts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "severity" "priority" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "subject_user_id" UUID,
    "evidence" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leakage_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cashier_shifts_property_id_status_idx" ON "cashier_shifts"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_shifts_property_id_id_key" ON "cashier_shifts"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_counts_shift_id_method_currency_key" ON "cash_counts"("shift_id", "method", "currency");

-- CreateIndex
CREATE INDEX "cash_handovers_from_shift_id_idx" ON "cash_handovers"("from_shift_id");

-- CreateIndex
CREATE INDEX "cash_handovers_to_user_id_idx" ON "cash_handovers"("to_user_id");

-- CreateIndex
CREATE INDEX "leakage_alerts_property_id_status_idx" ON "leakage_alerts"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "leakage_alerts_property_id_dedupe_key_key" ON "leakage_alerts"("property_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_property_id_shift_id_fkey" FOREIGN KEY ("property_id", "shift_id") REFERENCES "cashier_shifts"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_signed_off_by_id_fkey" FOREIGN KEY ("signed_off_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_from_shift_id_fkey" FOREIGN KEY ("from_shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leakage_alerts" ADD CONSTRAINT "leakage_alerts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leakage_alerts" ADD CONSTRAINT "leakage_alerts_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- M4 rule 4: one open shift per cashier per property (outlet shifts come with POS), and one
-- system shift per property for webhook payments.
CREATE UNIQUE INDEX "cashier_shifts_one_open" ON "cashier_shifts" ("property_id", "user_id")
  WHERE "status" = 'OPEN' AND "user_id" IS NOT NULL AND "outlet_id" IS NULL;
CREATE UNIQUE INDEX "cashier_shifts_one_system" ON "cashier_shifts" ("property_id")
  WHERE "status" = 'OPEN' AND "user_id" IS NULL AND "outlet_id" IS NULL;

ALTER TABLE "cashier_shifts"
  ADD CONSTRAINT "cashier_shifts_float_check" CHECK ("float_minor" >= 0),
  ADD CONSTRAINT "cashier_shifts_closed_check" CHECK (("status" = 'OPEN') = ("closed_at" IS NULL)),
  ADD CONSTRAINT "cashier_shifts_signoff_check" CHECK (
    "signed_off_by_id" IS NULL OR "status" = 'CLOSED');

-- A count is what was counted: never changed afterwards.
ALTER TABLE "cash_counts"
  ADD CONSTRAINT "cash_counts_counted_check" CHECK ("counted_minor" >= 0),
  ADD CONSTRAINT "cash_counts_variance_check" CHECK (
    "variance_minor" = "counted_minor" - "expected_minor");
CREATE TRIGGER cash_counts_append_only BEFORE UPDATE OR DELETE ON "cash_counts"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A handover is never deleted; the only change is its confirmation, once.
ALTER TABLE "cash_handovers"
  ADD CONSTRAINT "cash_handovers_amount_check" CHECK ("amount_minor" > 0);
CREATE OR REPLACE FUNCTION cash_handover_confirm_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.confirmed_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.from_shift_id <> OLD.from_shift_id
     OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id
     OR NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
     OR NEW.at <> OLD.at THEN
    RAISE EXCEPTION 'CASH_HANDOVER_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_handovers_confirm_only BEFORE UPDATE OR DELETE ON "cash_handovers"
  FOR EACH ROW EXECUTE FUNCTION cash_handover_confirm_only();

ALTER TABLE "leakage_alerts"
  ADD CONSTRAINT "leakage_alerts_status_check" CHECK ("status" IN ('OPEN', 'REVIEWED'));
