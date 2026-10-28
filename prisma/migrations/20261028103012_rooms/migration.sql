-- CreateEnum
CREATE TYPE "hk_status" AS ENUM ('DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "block_kind" AS ENUM ('OUT_OF_ORDER', 'OUT_OF_SERVICE');

-- CreateTable
CREATE TABLE "room_types" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_occupancy" INTEGER NOT NULL DEFAULT 2,
    "max_occupancy" INTEGER NOT NULL DEFAULT 2,
    "description" TEXT,
    "amenities" TEXT[],
    "photo_file_ids" UUID[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "floor" TEXT,
    "building" TEXT,
    "features" TEXT[],
    "connecting_room_id" UUID,
    "hk_status" "hk_status" NOT NULL DEFAULT 'DIRTY',
    "hk_status_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qr_token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_blocks" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "kind" "block_kind" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_code_key" ON "room_types"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_id_key" ON "room_types"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_qr_token_key" ON "rooms"("qr_token");

-- CreateIndex
CREATE INDEX "rooms_property_id_room_type_id_idx" ON "rooms"("property_id", "room_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_property_id_number_key" ON "rooms"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_property_id_id_key" ON "rooms"("property_id", "id");

-- CreateIndex
CREATE INDEX "room_blocks_property_id_start_date_idx" ON "room_blocks"("property_id", "start_date");

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_connecting_room_id_fkey" FOREIGN KEY ("connecting_room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-031) ──────────────────────────────────────────

ALTER TABLE "room_types"
  ADD CONSTRAINT "room_types_occupancy_check"
  CHECK (base_occupancy >= 1 AND base_occupancy <= max_occupancy AND max_occupancy <= 20);

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_connecting_not_self_check" CHECK (connecting_room_id <> id);

ALTER TABLE "room_blocks"
  ADD CONSTRAINT "room_blocks_dates_check" CHECK (end_date > start_date);

-- Unreleased blocks of one room never overlap (end date exclusive).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "room_blocks"
  ADD CONSTRAINT "room_blocks_no_overlap"
  EXCLUDE USING gist (room_id WITH =, daterange(start_date, end_date, '[)') WITH &&)
  WHERE (released_at IS NULL);
