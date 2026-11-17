-- CreateTable
CREATE TABLE "checklists" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" UUID NOT NULL,
    "items" TEXT[],
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "month_day" INTEGER,
    "due_time" TEXT NOT NULL DEFAULT '23:59',
    "assignee_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "checklists_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "checklist_runs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "checklist_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "items" TEXT[],
    "assignee_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '[]',
    "problems" INTEGER NOT NULL DEFAULT 0,
    "task_id" UUID,
    "completed_by_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "checklist_runs_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "checklists_property_id_active_idx" ON "checklists"("property_id", "active");
-- CreateIndex
CREATE UNIQUE INDEX "checklist_runs_task_id_key" ON "checklist_runs"("task_id");
-- CreateIndex
CREATE INDEX "checklist_runs_property_id_due_on_idx" ON "checklist_runs"("property_id", "due_on");
-- CreateIndex
CREATE UNIQUE INDEX "checklist_runs_checklist_id_due_on_key" ON "checklist_runs"("checklist_id", "due_on");
-- AddForeignKey
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "checklists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules (T-134).
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_schedule_check" CHECK (
  ("frequency" = 'DAILY' AND "weekday" IS NULL AND "month_day" IS NULL)
  OR ("frequency" = 'WEEKLY' AND "weekday" BETWEEN 1 AND 7 AND "month_day" IS NULL)
  OR ("frequency" = 'MONTHLY' AND "month_day" BETWEEN 1 AND 28 AND "weekday" IS NULL)
);
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_due_time_check" CHECK (
  "due_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_items_check" CHECK (
  cardinality("items") BETWEEN 1 AND 50
);
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_status_check" CHECK (
  ("status" IN ('PENDING', 'MISSED') AND "completed_at" IS NULL AND "completed_by_id" IS NULL
      AND "problems" = 0 AND "task_id" IS NULL)
  OR ("status" = 'DONE' AND "completed_at" IS NOT NULL AND "completed_by_id" IS NOT NULL)
);
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_problems_check" CHECK (
  "problems" >= 0 AND "problems" <= cardinality("items")
);
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_items_check" CHECK (
  cardinality("items") BETWEEN 1 AND 50
);
