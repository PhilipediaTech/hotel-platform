-- CreateEnum
CREATE TYPE "AccountingMappingKind" AS ENUM ('REVENUE_CODE', 'PAY_METHOD', 'EXPENSE_CATEGORY', 'CONTROL');

-- CreateTable
CREATE TABLE "accounting_mappings" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" "AccountingMappingKind" NOT NULL,
    "key" TEXT NOT NULL,
    "account_code" TEXT NOT NULL,
    "account_name" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_exports" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "journal_count" INTEGER NOT NULL,
    "line_count" INTEGER NOT NULL,
    "debit_total_minor" BIGINT NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_mappings_property_id_kind_key_key" ON "accounting_mappings"("property_id", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_exports_property_id_number_key" ON "accounting_exports"("property_id", "number");

-- AddForeignKey
ALTER TABLE "accounting_mappings" ADD CONSTRAINT "accounting_mappings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-148; PRD M10-07).
ALTER TABLE "accounting_mappings"
  ADD CONSTRAINT "accounting_mappings_code_check" CHECK ("account_code" ~ '^[A-Za-z0-9][A-Za-z0-9 ./:-]{0,29}$'),
  ADD CONSTRAINT "accounting_mappings_name_check" CHECK (
    "account_name" IS NULL OR length(btrim("account_name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "accounting_mappings_control_check" CHECK (
    "kind" <> 'CONTROL' OR "key" IN ('GUEST_LEDGER', 'ADVANCE_DEPOSITS', 'CITY_LEDGER'));
ALTER TABLE "accounting_exports"
  ADD CONSTRAINT "accounting_exports_period_check" CHECK ("to_date" >= "from_date"),
  ADD CONSTRAINT "accounting_exports_counts_check" CHECK (
    "journal_count" >= 0 AND "line_count" >= 0 AND "debit_total_minor" >= 0);
-- An export is kept exactly as it was sent.
CREATE TRIGGER accounting_exports_append_only BEFORE UPDATE OR DELETE ON "accounting_exports"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounting_mappings', 'accounting_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;
