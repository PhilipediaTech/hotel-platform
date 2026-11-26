-- Onboarding tracker (Versions V2 "enhanced onboarding"; Strategy "remote training sessions
-- per role"; T-171; Philip, 2026-11-26): the platform team books a remote training session
-- for a role of a hotel group and marks it held; the hotel sees its sessions under Help.

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID,
    "role_id" UUID NOT NULL,
    "trainer_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "held_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "training_sessions_organisation_id_scheduled_at_idx" ON "training_sessions"("organisation_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organisation_id_role_id_fkey" FOREIGN KEY ("organisation_id", "role_id") REFERENCES "roles"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_trainer_id_fkey" FOREIGN KEY ("trainer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules the application keeps, kept by the database too.
ALTER TABLE "training_sessions"
  ADD CONSTRAINT "training_sessions_state_check" CHECK ("held_at" IS NULL OR "cancelled_at" IS NULL),
  ADD CONSTRAINT "training_sessions_note_check" CHECK ("note" IS NULL OR length("note") <= 500);

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "training_sessions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "training_sessions"
  USING (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id())
  WITH CHECK (app_organisation_id() IS NULL OR "organisation_id" = app_organisation_id());
