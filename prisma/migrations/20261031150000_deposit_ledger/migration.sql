-- CreateEnum
CREATE TYPE "deposit_kind" AS ENUM ('RECEIVED', 'APPLIED', 'REFUNDED', 'FORFEITED');

-- CreateTable
CREATE TABLE "deposit_ledger_entries" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "payment_id" UUID,
    "kind" "deposit_kind" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "business_date" DATE NOT NULL,

    CONSTRAINT "deposit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deposit_ledger_entries_reservation_id_idx" ON "deposit_ledger_entries"("reservation_id");

-- CreateIndex
CREATE INDEX "deposit_ledger_entries_property_id_business_date_idx" ON "deposit_ledger_entries"("property_id", "business_date");

-- AddForeignKey
ALTER TABLE "deposit_ledger_entries" ADD CONSTRAINT "deposit_ledger_entries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_ledger_entries" ADD CONSTRAINT "deposit_ledger_entries_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_ledger_entries" ADD CONSTRAINT "deposit_ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M4 rule 1: the deposit ledger is append-only.
CREATE TRIGGER deposit_ledger_entries_append_only BEFORE UPDATE OR DELETE ON "deposit_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Tab 3 constraint 5: a closed business day takes no new entries.
CREATE TRIGGER deposit_ledger_entries_open_day BEFORE INSERT ON "deposit_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_day();

-- Money in comes with its payment; everything else takes money out of the deposit.
ALTER TABLE "deposit_ledger_entries"
  ADD CONSTRAINT "deposit_ledger_entries_sign_check" CHECK (
    ("kind" = 'RECEIVED' AND "amount_minor" > 0 AND "payment_id" IS NOT NULL)
    OR ("kind" <> 'RECEIVED' AND "amount_minor" < 0));
CREATE UNIQUE INDEX "deposit_ledger_entries_received_payment_key"
  ON "deposit_ledger_entries" ("payment_id") WHERE "kind" = 'RECEIVED';
