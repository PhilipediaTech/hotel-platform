-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "bank_account" TEXT NOT NULL,
    "file_name" TEXT,
    "posted_on" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "balance_minor" BIGINT,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "imported_by_id" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "statement_line_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payment_id" UUID,
    "ar_payment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_lines_property_id_status_posted_on_idx" ON "bank_statement_lines"("property_id", "status", "posted_on");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_property_id_fingerprint_key" ON "bank_statement_lines"("property_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_property_id_id_key" ON "bank_statement_lines"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_payment_id_key" ON "reconciliation_matches"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_ar_payment_id_key" ON "reconciliation_matches"("ar_payment_id");

-- CreateIndex
CREATE INDEX "reconciliation_matches_property_id_statement_line_id_idx" ON "reconciliation_matches"("property_id", "statement_line_id");

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_property_id_statement_line_id_fkey" FOREIGN KEY ("property_id", "statement_line_id") REFERENCES "bank_statement_lines"("property_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_ar_payment_id_fkey" FOREIGN KEY ("ar_payment_id") REFERENCES "ar_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Checks (T-128)
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_status_check" CHECK ("status" IN ('UNMATCHED', 'MATCHED'));
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_amount_check" CHECK ("amount_minor" <> 0);
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_kind_check" CHECK ("kind" IN ('PAYMENT', 'AR_PAYMENT', 'DIFFERENCE', 'EXPLAINED'));
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_link_check" CHECK (
  ("kind" = 'PAYMENT' AND "payment_id" IS NOT NULL AND "ar_payment_id" IS NULL)
  OR ("kind" = 'AR_PAYMENT' AND "ar_payment_id" IS NOT NULL AND "payment_id" IS NULL)
  OR ("kind" IN ('DIFFERENCE', 'EXPLAINED') AND "payment_id" IS NULL AND "ar_payment_id" IS NULL AND "note" IS NOT NULL)
);
