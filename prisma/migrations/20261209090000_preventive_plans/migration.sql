-- CreateTable
CREATE TABLE "preventive_plans" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "asset_id" UUID,
    "trigger" TEXT NOT NULL,
    "every_days" INTEGER,
    "every_hours" INTEGER,
    "lead_days" INTEGER NOT NULL DEFAULT 3,
    "lead_hours" INTEGER NOT NULL DEFAULT 10,
    "next_due_on" DATE,
    "last_done_on" DATE,
    "meter_hours" INTEGER,
    "meter_read_at" TIMESTAMPTZ(6),
    "last_service_hours" INTEGER,
    "assignee_id" UUID,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "open_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "preventive_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preventive_plans_open_task_id_key" ON "preventive_plans"("open_task_id");

-- CreateIndex
CREATE INDEX "preventive_plans_property_id_active_idx" ON "preventive_plans"("property_id", "active");

-- AddForeignKey
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_open_task_id_fkey" FOREIGN KEY ("open_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Plan rules (T-131): a calendar plan has a day interval and a due date; a run-hours plan has
-- an hour interval, an asset and the meter reading at its last service.
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_trigger_check" CHECK (
  ("trigger" = 'CALENDAR' AND "every_days" > 0 AND "every_hours" IS NULL AND "next_due_on" IS NOT NULL)
  OR ("trigger" = 'RUN_HOURS' AND "every_hours" > 0 AND "every_days" IS NULL
      AND "asset_id" IS NOT NULL AND "last_service_hours" IS NOT NULL AND "meter_hours" IS NOT NULL)
);
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_amounts_check" CHECK (
  "lead_days" >= 0 AND "lead_hours" >= 0
  AND ("meter_hours" IS NULL OR "meter_hours" >= 0)
  AND ("last_service_hours" IS NULL OR "last_service_hours" >= 0)
);
ALTER TABLE "preventive_plans" ADD CONSTRAINT "preventive_plans_priority_check" CHECK (
  "priority" IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')
);
