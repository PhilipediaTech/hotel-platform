-- CreateEnum
CREATE TYPE "ExpensePaidFrom" AS ENUM ('PETTY_CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE');

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_floats" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "custodian_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_floats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "petty_cash_top_ups" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "float_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reference" TEXT,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "spent_on" DATE NOT NULL,
    "category_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "supplier_id" UUID,
    "payee" TEXT,
    "description" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_from" "ExpensePaidFrom" NOT NULL,
    "float_id" UUID,
    "reference" TEXT,
    "receipt_file_id" UUID,
    "recorded_by_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approval_request_id" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "voided_by_id" UUID,
    "void_reason" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_property_id_code_key" ON "expense_categories"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_floats_property_id_name_key" ON "petty_cash_floats"("property_id", "name");

-- CreateIndex
CREATE INDEX "petty_cash_top_ups_float_id_idx" ON "petty_cash_top_ups"("float_id");

-- CreateIndex
CREATE INDEX "expenses_property_id_spent_on_idx" ON "expenses"("property_id", "spent_on");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_property_id_number_key" ON "expenses"("property_id", "number");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_custodian_id_fkey" FOREIGN KEY ("custodian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_top_ups" ADD CONSTRAINT "petty_cash_top_ups_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_top_ups" ADD CONSTRAINT "petty_cash_top_ups_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_top_ups" ADD CONSTRAINT "petty_cash_top_ups_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_float_id_fkey" FOREIGN KEY ("float_id") REFERENCES "petty_cash_floats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_file_id_fkey" FOREIGN KEY ("receipt_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-147; PRD M10-06 and M10 rule "expenses above limit need approval").
ALTER TABLE "expense_categories"
  ADD CONSTRAINT "expense_categories_code_check" CHECK ("code" ~ '^[A-Z0-9-]{2,12}$'),
  ADD CONSTRAINT "expense_categories_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "petty_cash_floats"
  ADD CONSTRAINT "petty_cash_floats_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "petty_cash_top_ups"
  ADD CONSTRAINT "petty_cash_top_ups_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "petty_cash_top_ups_reference_check" CHECK (
    "reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 60);
-- Money put into a float is never edited: a mistake is corrected by the float's expenses.
CREATE TRIGGER petty_cash_top_ups_append_only BEFORE UPDATE OR DELETE ON "petty_cash_top_ups"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "expenses_description_check" CHECK (
    length(btrim("description")) BETWEEN 1 AND 200),
  -- Paid to a listed supplier or a named payee.
  ADD CONSTRAINT "expenses_payee_check" CHECK (
    ("supplier_id" IS NOT NULL OR "payee" IS NOT NULL)
    AND ("payee" IS NULL OR length(btrim("payee")) BETWEEN 1 AND 120)),
  -- Petty cash names its float; nothing else does.
  ADD CONSTRAINT "expenses_float_check" CHECK (("paid_from" = 'PETTY_CASH') = ("float_id" IS NOT NULL)),
  ADD CONSTRAINT "expenses_reference_check" CHECK (
    "reference" IS NULL OR length(btrim("reference")) BETWEEN 1 AND 60),
  ADD CONSTRAINT "expenses_approval_check" CHECK (
    ("approval_request_id" IS NULL) = ("approved_by_id" IS NULL)),
  -- A voided expense keeps who voided it, when and why.
  ADD CONSTRAINT "expenses_void_check" CHECK (
    ("voided_at" IS NULL) = ("voided_by_id" IS NULL)
    AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    AND ("void_reason" IS NULL OR length(btrim("void_reason")) BETWEEN 1 AND 500));

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expense_categories', 'petty_cash_floats', 'petty_cash_top_ups',
    'expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;

-- M10 rule: expenses above the recorder's limit need approval. New properties get this policy
-- when they are created; these are the ones that already exist (back office: 48 hours).
INSERT INTO "approval_policies" ("id", "organisation_id", "property_id", "action", "approver_role_ids", "expiry_minutes")
SELECT gen_random_uuid(), p."organisation_id", p."id", 'expense.approve',
       COALESCE((SELECT array_agg(r."id") FROM "roles" r
                 WHERE r."organisation_id" = p."organisation_id"
                   AND r."name" IN ('Owner', 'General Manager')), '{}'),
       2880
FROM "properties" p
ON CONFLICT ("property_id", "action") DO NOTHING;
