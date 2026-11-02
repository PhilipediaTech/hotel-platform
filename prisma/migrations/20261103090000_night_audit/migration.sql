-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('RUNNING', 'FAILED', 'COMPLETED');

-- CreateTable
CREATE TABLE "night_audit_runs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'RUNNING',
    "current_step" INTEGER NOT NULL DEFAULT 1,
    "started_by_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "night_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_steps" (
    "run_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "exceptions" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "night_audit_steps_pkey" PRIMARY KEY ("run_id","step")
);

-- CreateTable
CREATE TABLE "room_charge_postings" (
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "night" DATE NOT NULL,
    "business_date" DATE NOT NULL,
    "folio_line_id" UUID NOT NULL,

    CONSTRAINT "room_charge_postings_pkey" PRIMARY KEY ("property_id","stay_id","night")
);

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_runs_property_id_business_date_key" ON "night_audit_runs"("property_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_runs_property_id_id_key" ON "night_audit_runs"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "room_charge_postings_folio_line_id_key" ON "room_charge_postings"("folio_line_id");

-- AddForeignKey
ALTER TABLE "night_audit_runs" ADD CONSTRAINT "night_audit_runs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_runs" ADD CONSTRAINT "night_audit_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_steps" ADD CONSTRAINT "night_audit_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "night_audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_charge_postings" ADD CONSTRAINT "room_charge_postings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_charge_postings" ADD CONSTRAINT "room_charge_postings_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_charge_postings" ADD CONSTRAINT "room_charge_postings_folio_line_id_fkey" FOREIGN KEY ("folio_line_id") REFERENCES "folio_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Night audit (T-073): ten steps per run, numbered 1–10 (M4 rule 8).
ALTER TABLE "night_audit_runs"
  ADD CONSTRAINT "night_audit_runs_step_check" CHECK ("current_step" BETWEEN 1 AND 10),
  ADD CONSTRAINT "night_audit_runs_finished_check" CHECK (("status" = 'COMPLETED') = ("finished_at" IS NOT NULL));
ALTER TABLE "night_audit_steps"
  ADD CONSTRAINT "night_audit_steps_step_check" CHECK ("step" BETWEEN 1 AND 10),
  ADD CONSTRAINT "night_audit_steps_status_check"
    CHECK ("status" IN ('PENDING', 'DONE', 'BLOCKED', 'FAILED', 'SKIPPED'));

-- A room posting is a fact: it never changes or goes away (a reversal corrects the line).
CREATE TRIGGER room_charge_postings_append_only BEFORE UPDATE OR DELETE ON "room_charge_postings"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

