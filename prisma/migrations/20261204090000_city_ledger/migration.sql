-- CreateTable
CREATE TABLE "ar_accounts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "credit_limit_minor" BIGINT NOT NULL,
    "terms_days" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_invoices" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "ar_account_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "folio_id" UUID,
    "payment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "einvoice_irn" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_payments" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "ar_account_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reference" TEXT,
    "received_on" DATE NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ar_allocations" (
    "ar_payment_id" UUID NOT NULL,
    "ar_invoice_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ar_allocations_pkey" PRIMARY KEY ("ar_payment_id","ar_invoice_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ar_accounts_property_id_company_id_key" ON "ar_accounts"("property_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "ar_invoices_payment_id_key" ON "ar_invoices"("payment_id");

-- CreateIndex
CREATE INDEX "ar_invoices_ar_account_id_due_on_idx" ON "ar_invoices"("ar_account_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "ar_invoices_property_id_number_key" ON "ar_invoices"("property_id", "number");

-- CreateIndex
CREATE INDEX "ar_payments_ar_account_id_received_on_idx" ON "ar_payments"("ar_account_id", "received_on");

-- AddForeignKey
ALTER TABLE "ar_accounts" ADD CONSTRAINT "ar_accounts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_accounts" ADD CONSTRAINT "ar_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_ar_account_id_fkey" FOREIGN KEY ("ar_account_id") REFERENCES "ar_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_invoices" ADD CONSTRAINT "ar_invoices_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_payments" ADD CONSTRAINT "ar_payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_payments" ADD CONSTRAINT "ar_payments_ar_account_id_fkey" FOREIGN KEY ("ar_account_id") REFERENCES "ar_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_payments" ADD CONSTRAINT "ar_payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_ar_payment_id_fkey" FOREIGN KEY ("ar_payment_id") REFERENCES "ar_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ar_allocations" ADD CONSTRAINT "ar_allocations_ar_invoice_id_fkey" FOREIGN KEY ("ar_invoice_id") REFERENCES "ar_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ar_accounts"
  ADD CONSTRAINT "ar_accounts_status_check" CHECK ("status" IN ('ACTIVE', 'ON_HOLD', 'CLOSED')),
  ADD CONSTRAINT "ar_accounts_numbers_check" CHECK ("credit_limit_minor" >= 0 AND "terms_days" >= 0);
ALTER TABLE "ar_invoices"
  ADD CONSTRAINT "ar_invoices_amount_check" CHECK ("amount_minor" > 0 AND "due_on" >= "issued_on");
ALTER TABLE "ar_payments"
  ADD CONSTRAINT "ar_payments_method_check" CHECK ("method" IN ('BANK_TRANSFER', 'CASH', 'POS_TERMINAL', 'CHEQUE')),
  ADD CONSTRAINT "ar_payments_amount_check" CHECK ("amount_minor" > 0);
ALTER TABLE "ar_allocations"
  ADD CONSTRAINT "ar_allocations_amount_check" CHECK ("amount_minor" > 0);
