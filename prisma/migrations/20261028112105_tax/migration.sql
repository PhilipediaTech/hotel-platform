-- CreateEnum
CREATE TYPE "revenue_group" AS ENUM ('ROOM', 'FNB', 'OTHER', 'TAX', 'SERVICE_CHARGE', 'FX', 'FEE');

-- CreateEnum
CREATE TYPE "tax_basis" AS ENUM ('NET', 'NET_PLUS_PRIOR');

-- CreateTable
CREATE TABLE "revenue_codes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" "revenue_group" NOT NULL,
    "tax_rule_ids" UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "revenue_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "revenue_code_id" UUID NOT NULL,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rule_versions" (
    "id" UUID NOT NULL,
    "tax_rule_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "rate_bps" INTEGER NOT NULL,
    "basis" "tax_basis" NOT NULL DEFAULT 'NET',
    "sequence" INTEGER NOT NULL,
    "inclusive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_codes_property_id_code_key" ON "revenue_codes"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_codes_property_id_id_key" ON "revenue_codes"("property_id", "id");

-- CreateIndex
CREATE INDEX "tax_rule_versions_tax_rule_id_effective_from_idx" ON "tax_rule_versions"("tax_rule_id", "effective_from");

-- AddForeignKey
ALTER TABLE "revenue_codes" ADD CONSTRAINT "revenue_codes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_property_id_revenue_code_id_fkey" FOREIGN KEY ("property_id", "revenue_code_id") REFERENCES "revenue_codes"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rule_versions" ADD CONSTRAINT "tax_rule_versions_tax_rule_id_fkey" FOREIGN KEY ("tax_rule_id") REFERENCES "tax_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-032) ──────────────────────────────────────────

-- 0–100% in basis points; sequence orders the stack.
ALTER TABLE "tax_rule_versions"
  ADD CONSTRAINT "tax_rule_versions_rate_check" CHECK (rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT "tax_rule_versions_sequence_check" CHECK (sequence BETWEEN 1 AND 99),
  ADD CONSTRAINT "tax_rule_versions_dates_check"
    CHECK (effective_to IS NULL OR effective_to > effective_from);

-- One version of a rule in force on any date (open-ended versions run to infinity).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "tax_rule_versions"
  ADD CONSTRAINT "tax_rule_versions_no_overlap"
  EXCLUDE USING gist (tax_rule_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&);

-- Versions are history: they are added, never changed or removed, except closing the open
-- one (setting effective_to) when a newer version starts.
CREATE OR REPLACE FUNCTION tax_rule_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_rule_versions is append-only';
  END IF;
  IF OLD.effective_to IS NOT NULL
     OR (NEW.tax_rule_id, NEW.effective_from, NEW.rate_bps, NEW.basis, NEW.sequence, NEW.inclusive)
        IS DISTINCT FROM
        (OLD.tax_rule_id, OLD.effective_from, OLD.rate_bps, OLD.basis, OLD.sequence, OLD.inclusive)
  THEN
    RAISE EXCEPTION 'tax_rule_versions is append-only';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tax_rule_versions_append_only BEFORE UPDATE OR DELETE ON tax_rule_versions
  FOR EACH ROW EXECUTE FUNCTION tax_rule_versions_immutable();
