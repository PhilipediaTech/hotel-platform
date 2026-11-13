-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "inspector_id" UUID NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "fail_reasons" TEXT[],
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inspections_property_id_at_idx" ON "inspections"("property_id", "at");

-- CreateIndex
CREATE INDEX "inspections_property_id_room_id_at_idx" ON "inspections"("property_id", "room_id", "at");

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A room that passes has no fail reasons; one that fails has at least one (M5-06).
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_reasons_check"
    CHECK ("fail_reasons" IS NOT NULL
      AND "passed" = (cardinality("fail_reasons") = 0));
