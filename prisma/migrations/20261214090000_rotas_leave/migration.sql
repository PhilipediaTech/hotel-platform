-- CreateTable
CREATE TABLE "duties" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "weekdays" INTEGER[],
    "start_time" TEXT,
    "end_time" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "duties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rota_patterns" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rota_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "pattern_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "leave_request_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duties_property_id_active_idx" ON "duties"("property_id", "active");

-- CreateIndex
CREATE INDEX "duties_staff_id_idx" ON "duties"("staff_id");

-- CreateIndex
CREATE INDEX "rota_patterns_property_id_idx" ON "rota_patterns"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "rota_patterns_department_id_name_key" ON "rota_patterns"("department_id", "name");

-- CreateIndex
CREATE INDEX "shift_assignments_property_id_date_idx" ON "shift_assignments"("property_id", "date");

-- CreateIndex
CREATE INDEX "shift_assignments_staff_id_date_idx" ON "shift_assignments"("staff_id", "date");

-- CreateIndex
CREATE INDEX "leave_requests_property_id_status_idx" ON "leave_requests"("property_id", "status");

-- CreateIndex
CREATE INDEX "leave_requests_staff_id_start_date_idx" ON "leave_requests"("staff_id", "start_date");

-- AddForeignKey
ALTER TABLE "duties" ADD CONSTRAINT "duties_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duties" ADD CONSTRAINT "duties_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_patterns" ADD CONSTRAINT "rota_patterns_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rota_patterns" ADD CONSTRAINT "rota_patterns_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_pattern_id_fkey" FOREIGN KEY ("pattern_id") REFERENCES "rota_patterns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_leave_request_id_fkey" FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-137).
CREATE UNIQUE INDEX "shift_assignments_live_key" ON "shift_assignments"("pattern_id", "staff_id", "date")
  WHERE "status" <> 'REMOVED';
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_status_check" CHECK (
  "status" IN ('DRAFT', 'PUBLISHED', 'REMOVED')
);
ALTER TABLE "duties" ADD CONSTRAINT "duties_weekdays_check" CHECK (
  "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
);
ALTER TABLE "duties" ADD CONSTRAINT "duties_times_check" CHECK (
  ("start_time" IS NULL OR "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  AND ("end_time" IS NULL OR "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
ALTER TABLE "rota_patterns" ADD CONSTRAINT "rota_patterns_times_check" CHECK (
  "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "start_time" <> "end_time"
);
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_type_check" CHECK (
  "type" IN ('ANNUAL', 'SICK', 'UNPAID', 'COMPASSIONATE', 'OTHER')
);
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_status_check" CHECK (
  ("status" = 'PENDING' AND "decided_at" IS NULL)
  OR ("status" IN ('APPROVED', 'REJECTED') AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL)
  OR "status" = 'CANCELLED'
);
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_dates_check" CHECK (
  "end_date" >= "start_date"
);
