-- CreateTable
CREATE TABLE "commissions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "travel_agent_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "checked_out_on" DATE NOT NULL,
    "base_minor" BIGINT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "settled_on" DATE,
    "reference" TEXT,
    "ar_payment_id" UUID,
    "settled_by_id" UUID,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commissions_property_id_status_travel_agent_id_idx" ON "commissions"("property_id", "status", "travel_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_property_id_stay_id_key" ON "commissions"("property_id", "stay_id");

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_travel_agent_id_fkey" FOREIGN KEY ("travel_agent_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_ar_payment_id_fkey" FOREIGN KEY ("ar_payment_id") REFERENCES "ar_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_settled_by_id_fkey" FOREIGN KEY ("settled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A commission offset against the agent's account is a credit on the city ledger (T-127).
ALTER TABLE "ar_payments" DROP CONSTRAINT "ar_payments_method_check";
ALTER TABLE "ar_payments"
  ADD CONSTRAINT "ar_payments_method_check" CHECK ("method" IN ('BANK_TRANSFER', 'CASH', 'POS_TERMINAL', 'CHEQUE', 'COMMISSION_OFFSET'));

ALTER TABLE "commissions"
  ADD CONSTRAINT "commissions_status_check" CHECK ("status" IN ('DUE', 'PAID', 'OFFSET')),
  ADD CONSTRAINT "commissions_rate_check" CHECK ("rate_bps" > 0 AND "rate_bps" <= 10000),
  ADD CONSTRAINT "commissions_amount_check" CHECK ("amount_minor" >= 0 AND "base_minor" >= 0),
  ADD CONSTRAINT "commissions_settled_check" CHECK (
    ("status" = 'DUE' AND "settled_on" IS NULL)
    OR ("status" <> 'DUE' AND "settled_on" IS NOT NULL)
  ),
  ADD CONSTRAINT "commissions_offset_check" CHECK (("status" = 'OFFSET') = ("ar_payment_id" IS NOT NULL));
