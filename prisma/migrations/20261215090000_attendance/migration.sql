-- AlterTable
ALTER TABLE "staff_profiles" ADD COLUMN     "location_consent_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "channel" TEXT NOT NULL,
    "ip" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracy_meters" INTEGER,
    "photo_file_id" UUID,
    "device_label" TEXT,
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_events_property_id_at_idx" ON "attendance_events"("property_id", "at");

-- CreateIndex
CREATE INDEX "attendance_events_staff_id_at_idx" ON "attendance_events"("staff_id", "at");

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-138).
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_kind_check" CHECK ("kind" IN ('IN', 'OUT'));
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_channel_check" CHECK (
  "channel" IN ('TABLET', 'PHONE')
);
-- The tablet always takes a photo (M7-04 "PIN + photo").
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_photo_check" CHECK (
  "channel" <> 'TABLET' OR "photo_file_id" IS NOT NULL
);
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_location_check" CHECK (
  ("latitude" IS NULL) = ("longitude" IS NULL)
  AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90)
  AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)
);
