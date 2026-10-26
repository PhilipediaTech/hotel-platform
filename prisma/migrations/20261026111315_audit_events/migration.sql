-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID,
    "actor_user_id" UUID,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "approval_request_id" UUID,
    "request_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_property_id_occurred_at_idx" ON "audit_events"("property_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_organisation_id_occurred_at_idx" ON "audit_events"("organisation_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_type"
  CHECK ("actor_type" IN ('USER', 'SYSTEM', 'SUPPORT'));
-- A user actor needs a user; system and support actions may have none.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_actor"
  CHECK ("actor_type" <> 'USER' OR "actor_user_id" IS NOT NULL);

-- Append-only tables (tab 3, constraints section 4).
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
