-- CreateEnum
CREATE TYPE "task_type" AS ENUM ('GUEST_REQUEST', 'COMPLAINT', 'FAULT', 'INCIDENT', 'CHECKLIST', 'DISCREPANCY', 'GENERAL');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('REPORTED', 'TRIAGED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'VERIFIED', 'CLOSED');

-- CreateTable
CREATE TABLE "task_templates" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "type" "task_type" NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" UUID NOT NULL,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "sla_minutes" INTEGER,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "task_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "task_type" NOT NULL,
    "template_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "department_id" UUID NOT NULL,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "status" "task_status" NOT NULL DEFAULT 'REPORTED',
    "room_id" UUID,
    "asset_id" UUID,
    "stay_id" UUID,
    "guest_id" UUID,
    "reported_by_id" UUID,
    "assignee_id" UUID,
    "due_at" TIMESTAMPTZ(6),
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "verified_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" BIGSERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_status" "task_status",
    "to_status" "task_status",
    "note" TEXT,
    "file_ids" UUID[],
    "by_user_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_templates_property_id_idx" ON "task_templates"("property_id");

-- CreateIndex
CREATE INDEX "tasks_property_id_status_idx" ON "tasks"("property_id", "status");

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_idx" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_property_id_number_key" ON "tasks"("property_id", "number");

-- CreateIndex
CREATE INDEX "task_events_task_id_idx" ON "task_events"("task_id");

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_property_id_department_id_fkey" FOREIGN KEY ("property_id", "department_id") REFERENCES "departments"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_property_id_department_id_fkey" FOREIGN KEY ("property_id", "department_id") REFERENCES "departments"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "task_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stay_id_fkey" FOREIGN KEY ("stay_id") REFERENCES "stays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

