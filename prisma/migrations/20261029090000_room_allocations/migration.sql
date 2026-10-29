-- CreateTable
CREATE TABLE "room_allocations" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_allocations_property_id_start_date_idx" ON "room_allocations"("property_id", "start_date");

-- CreateIndex
CREATE INDEX "room_allocations_stay_id_idx" ON "room_allocations"("stay_id");

-- CreateIndex
CREATE INDEX "room_allocations_room_id_idx" ON "room_allocations"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "stays_property_id_id_key" ON "stays"("property_id", "id");

-- AddForeignKey
ALTER TABLE "room_allocations" ADD CONSTRAINT "room_allocations_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_allocations" ADD CONSTRAINT "room_allocations_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tab 3 constraint 1: a room is never given to two stays for the same night.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "room_allocations"
  ADD CONSTRAINT "room_allocations_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  ) WHERE ("active");

-- At least one night.
ALTER TABLE "room_allocations"
  ADD CONSTRAINT "room_allocations_dates_check" CHECK ("end_date" > "start_date");
