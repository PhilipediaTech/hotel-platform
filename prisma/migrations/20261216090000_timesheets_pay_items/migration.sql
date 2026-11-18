-- CreateTable
CREATE TABLE "timesheets" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "worked_minutes" INTEGER NOT NULL,
    "overtime_minutes" INTEGER NOT NULL,
    "approved_overtime_minutes" INTEGER,
    "days_worked" INTEGER NOT NULL,
    "open_clocks" INTEGER NOT NULL,
    "days" JSONB NOT NULL,
    "calculated_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_items" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "pay_month" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timesheets_property_id_period_start_idx" ON "timesheets"("property_id", "period_start");

-- CreateIndex
CREATE INDEX "timesheets_staff_id_period_start_idx" ON "timesheets"("staff_id", "period_start");

-- CreateIndex
CREATE INDEX "pay_items_property_id_pay_month_idx" ON "pay_items"("property_id", "pay_month");

-- CreateIndex
CREATE INDEX "pay_items_staff_id_pay_month_idx" ON "pay_items"("staff_id", "pay_month");

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-139).
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_status_check" CHECK (
  ("status" = 'DRAFT' AND "approved_at" IS NULL AND "approved_overtime_minutes" IS NULL)
  OR ("status" = 'APPROVED' AND "approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL
      AND "approved_overtime_minutes" IS NOT NULL)
);
-- One calendar month at most, so payroll for a month adds whole timesheets.
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_period_check" CHECK (
  "period_end" >= "period_start"
  AND date_trunc('month', "period_start") = date_trunc('month', "period_end")
);
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_minutes_check" CHECK (
  "worked_minutes" >= 0 AND "overtime_minutes" >= 0 AND "overtime_minutes" <= "worked_minutes"
  AND "days_worked" >= 0 AND "open_clocks" >= 0
  AND ("approved_overtime_minutes" IS NULL
       OR "approved_overtime_minutes" BETWEEN 0 AND "overtime_minutes")
);
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_no_overlap"
  EXCLUDE USING gist (staff_id WITH =, daterange(period_start, period_end, '[]') WITH &&);

ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_type_check" CHECK ("type" IN ('ADVANCE', 'DEDUCTION'));
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_amount_check" CHECK ("amount_minor" > 0);
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_month_check" CHECK (
  "pay_month" = date_trunc('month', "pay_month")::date
);
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_status_check" CHECK (
  ("status" IN ('PENDING', 'CANCELLED') AND "decided_at" IS NULL)
  OR ("status" IN ('APPROVED', 'REJECTED') AND "decided_at" IS NOT NULL
      AND "decided_by_id" IS NOT NULL)
);
-- Four eyes: the approver is never the person who recorded it.
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_four_eyes_check" CHECK (
  "decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id"
);
