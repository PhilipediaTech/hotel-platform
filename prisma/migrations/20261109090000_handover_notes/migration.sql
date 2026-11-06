-- CreateTable
CREATE TABLE "handover_notes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "content" JSONB NOT NULL,
    "written_by_id" UUID NOT NULL,
    "acknowledged_by_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "handover_notes_property_id_created_at_idx" ON "handover_notes"("property_id", "created_at");

-- AddForeignKey
ALTER TABLE "handover_notes" ADD CONSTRAINT "handover_notes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_notes" ADD CONSTRAINT "handover_notes_property_id_department_id_fkey" FOREIGN KEY ("property_id", "department_id") REFERENCES "departments"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_notes" ADD CONSTRAINT "handover_notes_written_by_id_fkey" FOREIGN KEY ("written_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_notes" ADD CONSTRAINT "handover_notes_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A handover note is never deleted or rewritten; the only change is its acknowledgement, once.
CREATE OR REPLACE FUNCTION handover_note_acknowledge_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.acknowledged_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id
     OR NEW.department_id <> OLD.department_id OR NEW.business_date <> OLD.business_date
     OR NEW.content <> OLD.content OR NEW.written_by_id <> OLD.written_by_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HANDOVER_NOTE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER handover_notes_acknowledge_only BEFORE UPDATE OR DELETE ON "handover_notes"
  FOR EACH ROW EXECUTE FUNCTION handover_note_acknowledge_only();
