-- CreateTable
CREATE TABLE "webhook_events" (
    "id" BIGSERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "signature_ok" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_accounts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "virtual_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmatched_transfers" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "sender_name" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "matched_payment_id" UUID,

    CONSTRAINT "unmatched_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "virtual_accounts_property_id_owner_type_owner_id_idx" ON "virtual_accounts"("property_id", "owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_provider_account_number_key" ON "virtual_accounts"("provider", "account_number");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_transfers_matched_payment_id_key" ON "unmatched_transfers"("matched_payment_id");

-- CreateIndex
CREATE INDEX "unmatched_transfers_property_id_matched_payment_id_idx" ON "unmatched_transfers"("property_id", "matched_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_transfers_provider_external_ref_key" ON "unmatched_transfers"("provider", "external_ref");

-- AddForeignKey
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unmatched_transfers" ADD CONSTRAINT "unmatched_transfers_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unmatched_transfers" ADD CONSTRAINT "unmatched_transfers_matched_payment_id_fkey" FOREIGN KEY ("matched_payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Webhooks and virtual accounts (T-071).
ALTER TABLE "virtual_accounts"
  ADD CONSTRAINT "virtual_accounts_owner_check"
    CHECK ("owner_type" IN ('FOLIO', 'COMPANY', 'EVENT', 'GUEST'));
ALTER TABLE "unmatched_transfers"
  ADD CONSTRAINT "unmatched_transfers_amount_check" CHECK ("amount_minor" > 0);

-- A webhook is kept as it arrived: only its processing marks change.
CREATE OR REPLACE FUNCTION webhook_events_keep_payload() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'webhook_events keeps each event as it arrived';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER webhook_events_keep_payload BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION webhook_events_keep_payload();
