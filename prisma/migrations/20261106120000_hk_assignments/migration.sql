-- CreateEnum
CREATE TYPE "hk_task_kind" AS ENUM ('DEPARTURE', 'STAYOVER', 'ARRIVAL', 'DEEP_CLEAN');

-- CreateTable
CREATE TABLE "hk_assignments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "room_id" UUID NOT NULL,
    "kind" "hk_task_kind" NOT NULL,
    "attendant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "minibar" JSONB,
    "notes" TEXT,

    CONSTRAINT "hk_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hk_assignments_attendant_id_business_date_idx" ON "hk_assignments"("attendant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "hk_assignments_property_id_business_date_room_id_key" ON "hk_assignments"("property_id", "business_date", "room_id");

-- AddForeignKey
ALTER TABLE "hk_assignments" ADD CONSTRAINT "hk_assignments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hk_assignments" ADD CONSTRAINT "hk_assignments_property_id_room_id_fkey" FOREIGN KEY ("property_id", "room_id") REFERENCES "rooms"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hk_assignments" ADD CONSTRAINT "hk_assignments_attendant_id_fkey" FOREIGN KEY ("attendant_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Housekeeping (T-080): an assignment's status, and its times in step with it.
ALTER TABLE "hk_assignments"
  ADD CONSTRAINT "hk_assignments_status_check"
    CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'PAUSED', 'DONE')),
  ADD CONSTRAINT "hk_assignments_done_check"
    CHECK (("status" = 'DONE') = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT "hk_assignments_started_check"
    CHECK ("status" = 'PENDING' OR "started_at" IS NOT NULL);
