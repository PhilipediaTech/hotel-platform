-- CreateTable
CREATE TABLE "work_order_details" (
    "task_id" UUID NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "labour_minutes" INTEGER NOT NULL DEFAULT 0,
    "vendor_name" TEXT,
    "cost_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "work_order_details_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "location" TEXT,
    "room_id" UUID,
    "serial" TEXT,
    "vendor" TEXT,
    "warranty_until" DATE,
    "cost_minor" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'IN_SERVICE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_property_id_status_idx" ON "assets"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assets_property_id_tag_key" ON "assets"("property_id", "tag");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_details" ADD CONSTRAINT "work_order_details_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Asset statuses (M5-09), and no negative costs or time on a work order (M5-08).
ALTER TABLE "assets"
  ADD CONSTRAINT "assets_status_check"
    CHECK ("status" IN ('IN_SERVICE', 'OUT_OF_SERVICE', 'RETIRED')),
  ADD CONSTRAINT "assets_cost_check" CHECK ("cost_minor" IS NULL OR "cost_minor" >= 0);
ALTER TABLE "work_order_details"
  ADD CONSTRAINT "work_order_details_amounts_check"
    CHECK ("labour_minutes" >= 0 AND "cost_minor" >= 0),
  ADD CONSTRAINT "work_order_details_parts_check" CHECK (jsonb_typeof("parts") = 'array');
