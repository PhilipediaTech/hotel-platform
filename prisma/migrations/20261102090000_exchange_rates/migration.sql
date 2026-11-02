-- CreateTable
CREATE TABLE "exchange_rates" (
    "property_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "rate_micros" BIGINT NOT NULL,
    "set_by_id" UUID NOT NULL,
    "locked_at" TIMESTAMPTZ(6),

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("property_id","currency","business_date")
);

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A rate is positive and never for the base currency (checked in the app, which knows it).
ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "exchange_rates_rate_check" CHECK ("rate_micros" > 0),
  ADD CONSTRAINT "exchange_rates_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- M4-18: a locked rate (night audit, T-073) never changes or goes away.
CREATE OR REPLACE FUNCTION exchange_rates_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'EXCHANGE_RATE_LOCKED';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER exchange_rates_locked BEFORE UPDATE OR DELETE ON "exchange_rates"
  FOR EACH ROW EXECUTE FUNCTION exchange_rates_locked();

-- Folio transfers (T-065): a transfer line points at its other half.
ALTER TABLE "folio_lines"
  ADD CONSTRAINT "folio_lines_transfer_check" CHECK (
    "kind" NOT IN ('TRANSFER_IN', 'TRANSFER_OUT')
    OR ("source_type" = 'TRANSFER' AND "source_id" IS NOT NULL));
