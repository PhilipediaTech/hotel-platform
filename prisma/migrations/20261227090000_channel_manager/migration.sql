-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('CONNECTING', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ChannelMappingKind" AS ENUM ('ROOM_TYPE', 'RATE_PLAN');

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_property_id" TEXT,
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'CONNECTING',
    "last_error" TEXT,
    "setup_locked_until" TIMESTAMPTZ(6),
    "connected_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_mappings" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" "ChannelMappingKind" NOT NULL,
    "room_type_id" UUID NOT NULL,
    "rate_plan_id" UUID,
    "external_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_logs" (
    "id" BIGSERIAL NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "items" INTEGER NOT NULL DEFAULT 0,
    "task_id" TEXT,
    "message" TEXT,
    "details" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_property_id_key" ON "channel_connections"("property_id");

-- CreateIndex
CREATE INDEX "channel_mappings_property_id_kind_idx" ON "channel_mappings"("property_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "channel_mappings_connection_id_external_id_key" ON "channel_mappings"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "channel_sync_logs_connection_id_at_idx" ON "channel_sync_logs"("connection_id", "at");

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_logs" ADD CONSTRAINT "channel_sync_logs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_logs" ADD CONSTRAINT "channel_sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-151; PRD M11-07).
ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_provider_check" CHECK ("provider" IN ('CHANNEX')),
  ADD CONSTRAINT "channel_connections_active_check" CHECK (
    "status" = 'CONNECTING' OR "external_property_id" IS NOT NULL);
ALTER TABLE "channel_mappings"
  ADD CONSTRAINT "channel_mappings_kind_check" CHECK (
    ("kind" = 'RATE_PLAN') = ("rate_plan_id" IS NOT NULL));
-- One mapping per room type, and per rate plan and room type.
CREATE UNIQUE INDEX "channel_mappings_room_type_key" ON "channel_mappings" ("connection_id", "room_type_id")
  WHERE "kind" = 'ROOM_TYPE';
CREATE UNIQUE INDEX "channel_mappings_rate_plan_key" ON "channel_mappings" ("connection_id", "rate_plan_id", "room_type_id")
  WHERE "kind" = 'RATE_PLAN';
ALTER TABLE "channel_sync_logs"
  ADD CONSTRAINT "channel_sync_logs_kind_check" CHECK (
    "kind" IN ('SETUP', 'AVAILABILITY', 'RESTRICTIONS', 'FULL_SYNC', 'BOOKING')),
  ADD CONSTRAINT "channel_sync_logs_status_check" CHECK ("status" IN ('OK', 'WARNING', 'FAILED')),
  ADD CONSTRAINT "channel_sync_logs_items_check" CHECK ("items" >= 0);
-- The log is what happened: never edited.
CREATE TRIGGER channel_sync_logs_append_only BEFORE UPDATE OR DELETE ON "channel_sync_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_connections', 'channel_mappings', 'channel_sync_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;
