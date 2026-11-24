-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "ari_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "full_sync_at" TIMESTAMPTZ(6),
ADD COLUMN     "full_sync_pending" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sync_error" TEXT,
ADD COLUMN     "sync_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sync_locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "sync_retry_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "channel_ari_sent" (
    "mapping_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "values" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_ari_sent_pkey" PRIMARY KEY ("mapping_id")
);

-- CreateTable
CREATE TABLE "channel_ari_changes" (
    "id" BIGSERIAL NOT NULL,
    "property_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_ari_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_ari_sent_connection_id_idx" ON "channel_ari_sent"("connection_id");

-- CreateIndex
CREATE INDEX "channel_ari_changes_property_id_id_idx" ON "channel_ari_changes"("property_id", "id");

-- AddForeignKey
ALTER TABLE "channel_ari_sent" ADD CONSTRAINT "channel_ari_sent_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ari_sent" ADD CONSTRAINT "channel_ari_sent_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ari_sent" ADD CONSTRAINT "channel_ari_sent_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "channel_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ari_changes" ADD CONSTRAINT "channel_ari_changes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules (T-152) ----------------------------------------------------------------------------
ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_sync_failures_check" CHECK ("sync_failures" >= 0);
ALTER TABLE "channel_ari_sent"
  ADD CONSTRAINT "channel_ari_sent_values_check" CHECK (jsonb_typeof("values") = 'object');

-- A change to availability, prices or restrictions of a property connected to a channel
-- manager leaves a sign for the sync. Statement-level (one row per statement and property,
-- even when a bulk edit writes hundreds of days) and a plain insert, so concurrent bookings
-- never lock each other through it.
CREATE FUNCTION channel_ari_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO channel_ari_changes (property_id)
  SELECT DISTINCT r.property_id FROM changed_rows r
  WHERE EXISTS (
    SELECT 1 FROM channel_connections c
    WHERE c.property_id = r.property_id AND c.status = 'ACTIVE');
  RETURN NULL;
END $$;

CREATE TRIGGER room_type_inventory_channel_insert AFTER INSERT ON "room_type_inventory"
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();
CREATE TRIGGER room_type_inventory_channel_update AFTER UPDATE ON "room_type_inventory"
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();
CREATE TRIGGER rate_days_channel_insert AFTER INSERT ON "rate_days"
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();
CREATE TRIGGER rate_days_channel_update AFTER UPDATE ON "rate_days"
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();
CREATE TRIGGER rate_days_channel_delete AFTER DELETE ON "rate_days"
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();
CREATE TRIGGER rate_plans_channel_update AFTER UPDATE ON "rate_plans"
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION channel_ari_changed();

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_ari_sent', 'channel_ari_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;
