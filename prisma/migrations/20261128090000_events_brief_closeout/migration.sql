-- AlterTable
ALTER TABLE "event_bookings" ADD COLUMN     "closed_at" TIMESTAMPTZ(6),
ADD COLUMN     "damage_description" TEXT,
ADD COLUMN     "damage_total_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "folio_id" UUID,
ADD COLUMN     "inspected_at" TIMESTAMPTZ(6),
ADD COLUMN     "inspected_by_id" UUID,
ADD COLUMN     "inspection_notes" TEXT;

-- CreateTable
CREATE TABLE "event_briefs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "instructions" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "event_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_briefs_booking_id_department_id_key" ON "event_briefs"("booking_id", "department_id");

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_inspected_by_id_fkey" FOREIGN KEY ("inspected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_briefs" ADD CONSTRAINT "event_briefs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_briefs" ADD CONSTRAINT "event_briefs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "event_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_briefs" ADD CONSTRAINT "event_briefs_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_briefs" ADD CONSTRAINT "event_briefs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M9-08: a closed event no longer takes its space (it is outside event_bookings_no_overlap).
ALTER TABLE "event_bookings" DROP CONSTRAINT "event_bookings_status_check";
ALTER TABLE "event_bookings"
  ADD CONSTRAINT "event_bookings_status_check" CHECK ("status" IN ('HOLD', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'CLOSED')),
  ADD CONSTRAINT "event_bookings_damage_check" CHECK ("damage_total_minor" >= 0);
