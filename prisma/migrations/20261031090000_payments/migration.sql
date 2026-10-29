-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "folio_id" UUID,
    "window_id" UUID,
    "reservation_id" UUID,
    "method" "pay_method" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate_micros" BIGINT,
    "base_amount_minor" BIGINT NOT NULL,
    "provider" TEXT,
    "external_ref" TEXT,
    "business_date" DATE NOT NULL,
    "shift_id" UUID NOT NULL,
    "received_by_id" UUID,
    "refunds_payment_id" UUID,
    "approval_request_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_property_id_business_date_idx" ON "payments"("property_id", "business_date");

-- CreateIndex
CREATE INDEX "payments_folio_id_idx" ON "payments"("folio_id");

-- CreateIndex
CREATE INDEX "payments_shift_id_idx" ON "payments"("shift_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_folio_id_fkey" FOREIGN KEY ("property_id", "folio_id") REFERENCES "folios"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "folio_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_property_id_shift_id_fkey" FOREIGN KEY ("property_id", "shift_id") REFERENCES "cashier_shifts"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunds_payment_id_fkey" FOREIGN KEY ("refunds_payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M4 rule 1: payments are append-only (refunds are their own negative rows, T-072).
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Tab 3 constraint 5: a closed business day takes no new payments.
CREATE TRIGGER payments_open_day BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_day();

-- M4 rule 5 with open issue 19: a reference is used once. Gateways: per provider. Desk
-- payments (provider MANUAL): per property and method, so two hotels' POS slips never collide.
CREATE UNIQUE INDEX "payments_provider_external_ref_key" ON "payments" ("provider", "external_ref")
  WHERE "provider" <> 'MANUAL' AND "external_ref" IS NOT NULL;
CREATE UNIQUE INDEX "payments_manual_ref_key" ON "payments" ("property_id", "method", "external_ref")
  WHERE "provider" = 'MANUAL' AND "external_ref" IS NOT NULL;

ALTER TABLE "payments"
  -- A payment is money in; a refund is money out and points at what it refunds.
  ADD CONSTRAINT "payments_sign_check" CHECK (
    ("refunds_payment_id" IS NULL AND "amount_minor" > 0)
    OR ("refunds_payment_id" IS NOT NULL AND "amount_minor" < 0)),
  -- In the base currency the base amount is the amount; otherwise a rate is recorded.
  ADD CONSTRAINT "payments_base_check" CHECK (
    "rate_micros" IS NOT NULL OR "base_amount_minor" = "amount_minor"),
  -- A payment goes to a folio window, or (deposits, T-063) to a reservation.
  ADD CONSTRAINT "payments_target_check" CHECK (
    ("folio_id" IS NOT NULL AND "window_id" IS NOT NULL) OR "reservation_id" IS NOT NULL);
