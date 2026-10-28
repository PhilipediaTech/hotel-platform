-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('ENQUIRY', 'TENTATIVE', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "booking_source" AS ENUM ('WALK_IN', 'PHONE', 'EMAIL', 'WHATSAPP', 'DIRECT', 'OTA_MANUAL', 'OTA_CHANNEL', 'CORPORATE', 'TRAVEL_AGENT');

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "confirmation_no" TEXT NOT NULL,
    "booker_guest_id" UUID NOT NULL,
    "company_id" UUID,
    "travel_agent_id" UUID,
    "source" "booking_source" NOT NULL,
    "channel_ref" TEXT,
    "status" "reservation_status" NOT NULL DEFAULT 'CONFIRMED',
    "guarantee" "guarantee" NOT NULL DEFAULT 'NONE',
    "hold_expires_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stays" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "room_id" UUID,
    "rate_plan_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "arrival" DATE NOT NULL,
    "departure" DATE NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "status" "reservation_status" NOT NULL,
    "is_day_use" BOOLEAN NOT NULL DEFAULT false,
    "day_use_start" TIMESTAMPTZ(6),
    "day_use_end" TIMESTAMPTZ(6),
    "folio_id" UUID,
    "checked_in_at" TIMESTAMPTZ(6),
    "checked_out_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_nights" (
    "stay_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "rule_version" INTEGER NOT NULL,

    CONSTRAINT "stay_nights_pkey" PRIMARY KEY ("stay_id","date")
);

-- CreateTable
CREATE TABLE "reservation_status_history" (
    "id" BIGSERIAL NOT NULL,
    "reservation_id" UUID NOT NULL,
    "stay_id" UUID,
    "from_status" "reservation_status",
    "to_status" "reservation_status" NOT NULL,
    "reason" TEXT,
    "by_user_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_property_id_status_idx" ON "reservations"("property_id", "status");

-- CreateIndex
CREATE INDEX "reservations_status_hold_expires_at_idx" ON "reservations"("status", "hold_expires_at");

-- CreateIndex
CREATE INDEX "reservations_booker_guest_id_idx" ON "reservations"("booker_guest_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_property_id_confirmation_no_key" ON "reservations"("property_id", "confirmation_no");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_property_id_source_channel_ref_key" ON "reservations"("property_id", "source", "channel_ref");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_property_id_id_key" ON "reservations"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stays_quote_id_key" ON "stays"("quote_id");

-- CreateIndex
CREATE INDEX "stays_property_id_arrival_idx" ON "stays"("property_id", "arrival");

-- CreateIndex
CREATE INDEX "stays_property_id_departure_idx" ON "stays"("property_id", "departure");

-- CreateIndex
CREATE INDEX "stays_property_id_status_idx" ON "stays"("property_id", "status");

-- CreateIndex
CREATE INDEX "stays_reservation_id_idx" ON "stays"("reservation_id");

-- CreateIndex
CREATE INDEX "stays_guest_id_idx" ON "stays"("guest_id");

-- CreateIndex
CREATE INDEX "reservation_status_history_reservation_id_at_idx" ON "reservation_status_history"("reservation_id", "at");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_booker_guest_id_fkey" FOREIGN KEY ("booker_guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_travel_agent_id_fkey" FOREIGN KEY ("travel_agent_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_property_id_rate_plan_id_fkey" FOREIGN KEY ("property_id", "rate_plan_id") REFERENCES "rate_plans"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stays" ADD CONSTRAINT "stays_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_nights" ADD CONSTRAINT "stay_nights_stay_id_fkey" FOREIGN KEY ("stay_id") REFERENCES "stays"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_status_history" ADD CONSTRAINT "reservation_status_history_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (T-042): rules the schema language can't express.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_hold_needs_expiry" CHECK ("status" <> 'TENTATIVE' OR "hold_expires_at" IS NOT NULL),
  ADD CONSTRAINT "reservations_cancel_needs_time" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

ALTER TABLE "stays"
  ADD CONSTRAINT "stays_dates_check" CHECK ("departure" > "arrival" OR "is_day_use"),
  ADD CONSTRAINT "stays_guests_check" CHECK ("adults" >= 1 AND "children" >= 0);

-- Status history is append-only.
CREATE FUNCTION reservation_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reservation_status_history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_status_history_append_only
  BEFORE UPDATE OR DELETE ON "reservation_status_history"
  FOR EACH ROW EXECUTE FUNCTION reservation_status_history_append_only();
