-- CreateEnum
CREATE TYPE "alert_outcome_kind" AS ENUM ('EXPLAINED', 'RECOVERED', 'ACTION_TAKEN', 'FALSE_POSITIVE');

-- CreateTable
CREATE TABLE "leakage_rules" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL DEFAULT '{}',
    "notify_instant" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "leakage_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_outcomes" (
    "id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "outcome" "alert_outcome_kind" NOT NULL,
    "recovered_minor" BIGINT,
    "linked_line_id" UUID,
    "linked_payment_id" UUID,
    "note" TEXT NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leakage_rules_property_id_code_key" ON "leakage_rules"("property_id", "code");

-- CreateIndex
CREATE INDEX "alert_outcomes_alert_id_idx" ON "alert_outcomes"("alert_id");

-- AddForeignKey
ALTER TABLE "leakage_rules" ADD CONSTRAINT "leakage_rules_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_outcomes" ADD CONSTRAINT "alert_outcomes_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "leakage_alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_outcomes" ADD CONSTRAINT "alert_outcomes_linked_line_id_fkey" FOREIGN KEY ("linked_line_id") REFERENCES "folio_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_outcomes" ADD CONSTRAINT "alert_outcomes_linked_payment_id_fkey" FOREIGN KEY ("linked_payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_outcomes" ADD CONSTRAINT "alert_outcomes_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M6 rule 3: recovered amounts link to a folio line or payment; only RECOVERED carries one.
ALTER TABLE "alert_outcomes" ADD CONSTRAINT "alert_outcomes_recovered" CHECK (
  (outcome = 'RECOVERED') = (recovered_minor IS NOT NULL)
  AND (recovered_minor IS NULL OR recovered_minor > 0)
  AND (recovered_minor IS NULL OR num_nonnulls(linked_line_id, linked_payment_id) = 1)
  AND (recovered_minor IS NOT NULL OR num_nonnulls(linked_line_id, linked_payment_id) = 0)
);

-- Tab 3 trigger 4: outcomes are added, not edited (M6 rule 3).
CREATE TRIGGER alert_outcomes_append_only BEFORE UPDATE OR DELETE ON "alert_outcomes"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- M6 rule 3: an alert is immutable once raised. The only changes: its review (OPEN → REVIEWED,
-- once) and its subject user cleared when that user is removed (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION leakage_alert_review_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id
     OR NEW.rule_code <> OLD.rule_code OR NEW.business_date <> OLD.business_date
     OR NEW.severity <> OLD.severity OR NEW.entity_type <> OLD.entity_type
     OR NEW.entity_id <> OLD.entity_id OR NEW.evidence <> OLD.evidence
     OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.raised_at <> OLD.raised_at
     OR (NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id AND NEW.subject_user_id IS NOT NULL)
     OR (NEW.status <> OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status = 'REVIEWED')) THEN
    RAISE EXCEPTION 'LEAKAGE_ALERT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER leakage_alerts_review_only BEFORE UPDATE OR DELETE ON "leakage_alerts"
  FOR EACH ROW EXECUTE FUNCTION leakage_alert_review_only();
