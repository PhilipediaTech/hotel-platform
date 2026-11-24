-- CreateEnum
CREATE TYPE "ChannelBookingOutcome" AS ENUM ('PENDING', 'APPLIED', 'HELD', 'SUPERSEDED', 'DISMISSED');

-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "bookings_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "bookings_error" TEXT,
ADD COLUMN     "bookings_locked_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "channel_booking_revisions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_booking_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ota_name" TEXT,
    "ota_code" TEXT,
    "guest_name" TEXT NOT NULL,
    "arrival" DATE,
    "departure" DATE,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ(6),
    "outcome" "ChannelBookingOutcome" NOT NULL DEFAULT 'PENDING',
    "hold_reason" TEXT,
    "message" TEXT,
    "reservation_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_booking_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_booking_revisions_connection_id_external_booking_id_idx" ON "channel_booking_revisions"("connection_id", "external_booking_id");

-- CreateIndex
CREATE INDEX "channel_booking_revisions_property_id_outcome_idx" ON "channel_booking_revisions"("property_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "channel_booking_revisions_connection_id_external_id_key" ON "channel_booking_revisions"("connection_id", "external_id");

-- AddForeignKey
ALTER TABLE "channel_booking_revisions" ADD CONSTRAINT "channel_booking_revisions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_booking_revisions" ADD CONSTRAINT "channel_booking_revisions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_booking_revisions" ADD CONSTRAINT "channel_booking_revisions_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "channel_booking_revisions"
  ADD CONSTRAINT "channel_booking_revisions_kind_check" CHECK ("kind" IN ('NEW', 'MODIFIED', 'CANCELLED')),
  ADD CONSTRAINT "channel_booking_revisions_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  ADD CONSTRAINT "channel_booking_revisions_held_check" CHECK ("outcome" <> 'HELD' OR "hold_reason" IS NOT NULL),
  ADD CONSTRAINT "channel_booking_revisions_dates_check" CHECK ("arrival" IS NULL OR "departure" IS NULL OR "departure" > "arrival");

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "channel_booking_revisions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "channel_booking_revisions"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
