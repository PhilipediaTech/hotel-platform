-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "group_block_id" UUID;

-- CreateTable
CREATE TABLE "group_blocks" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company_id" UUID,
    "rate_plan_id" UUID NOT NULL,
    "arrival" DATE NOT NULL,
    "departure" DATE NOT NULL,
    "release_date" DATE,
    "release_days" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "group_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_block_nights" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "rooms" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "group_block_nights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_blocks_status_idx" ON "group_blocks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "group_blocks_property_id_code_key" ON "group_blocks"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "group_block_nights_block_id_room_type_id_date_key" ON "group_block_nights"("block_id", "room_type_id", "date");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_group_block_id_fkey" FOREIGN KEY ("group_block_id") REFERENCES "group_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_block_nights" ADD CONSTRAINT "group_block_nights_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_block_nights" ADD CONSTRAINT "group_block_nights_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "group_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_block_nights" ADD CONSTRAINT "group_block_nights_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "group_blocks"
  ADD CONSTRAINT "group_blocks_kind_check" CHECK ("kind" IN ('GROUP', 'ALLOTMENT')),
  ADD CONSTRAINT "group_blocks_status_check" CHECK ("status" IN ('ACTIVE', 'RELEASED', 'CANCELLED')),
  ADD CONSTRAINT "group_blocks_dates_check" CHECK ("departure" > "arrival"),
  -- A group has a release date; an allotment has release days.
  ADD CONSTRAINT "group_blocks_release_check" CHECK (
    ("kind" = 'GROUP' AND "release_date" IS NOT NULL AND "release_days" IS NULL)
    OR ("kind" = 'ALLOTMENT' AND "release_days" IS NOT NULL AND "release_date" IS NULL));
ALTER TABLE "group_block_nights"
  ADD CONSTRAINT "group_block_nights_counts_check" CHECK ("rooms" >= 0 AND "remaining" >= 0 AND "remaining" <= "rooms");
