-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "folio_id" UUID,
    "window_number" INTEGER,
    "reservation_id" UUID,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "idempotency_key" TEXT NOT NULL,
    "checkout_url" TEXT NOT NULL,
    "requested_by_id" UUID,
    "sent_to" TEXT,
    "payment_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_ref_key" ON "payment_intents"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_payment_id_key" ON "payment_intents"("payment_id");

-- CreateIndex
CREATE INDEX "payment_intents_property_id_status_idx" ON "payment_intents"("property_id", "status");

-- CreateIndex
CREATE INDEX "payment_intents_folio_id_idx" ON "payment_intents"("folio_id");

-- CreateIndex
CREATE INDEX "payment_intents_reservation_id_idx" ON "payment_intents"("reservation_id");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_property_id_folio_id_fkey" FOREIGN KEY ("property_id", "folio_id") REFERENCES "folios"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Online payments (T-070): a request pays a folio window or a booking's deposit, never both.
ALTER TABLE "payment_intents"
  ADD CONSTRAINT "payment_intents_target_check" CHECK (
    ("folio_id" IS NOT NULL AND "window_number" IS NOT NULL AND "reservation_id" IS NULL)
    OR ("folio_id" IS NULL AND "window_number" IS NULL AND "reservation_id" IS NOT NULL)),
  ADD CONSTRAINT "payment_intents_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "payment_intents_status_check"
    CHECK ("status" IN ('CREATED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  -- Succeeded exactly when it became a payment.
  ADD CONSTRAINT "payment_intents_paid_check" CHECK (
    ("status" = 'SUCCEEDED') = ("payment_id" IS NOT NULL)
    AND ("payment_id" IS NULL) = ("paid_at" IS NULL));
