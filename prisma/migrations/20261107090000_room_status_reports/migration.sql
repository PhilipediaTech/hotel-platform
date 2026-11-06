-- CreateEnum
CREATE TYPE "observed_status" AS ENUM ('OCCUPIED', 'VACANT', 'SLEPT_OUT', 'LUGGAGE_NO_GUEST', 'DO_NOT_DISTURB');

-- CreateTable
CREATE TABLE "room_status_reports" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "room_id" UUID NOT NULL,
    "observed" "observed_status" NOT NULL,
    "reported_by_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_status_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_status_reports_property_id_business_date_room_id_idx" ON "room_status_reports"("property_id", "business_date", "room_id");

-- AddForeignKey
ALTER TABLE "room_status_reports" ADD CONSTRAINT "room_status_reports_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_status_reports" ADD CONSTRAINT "room_status_reports_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_status_reports" ADD CONSTRAINT "room_status_reports_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

