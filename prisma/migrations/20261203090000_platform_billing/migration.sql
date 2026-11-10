-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "suspended_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "platform_invoices" ADD COLUMN     "due_on" DATE,
ADD COLUMN     "paid_at" TIMESTAMPTZ(6),
ADD COLUMN     "paid_ref" TEXT;

-- CreateTable
CREATE TABLE "platform_invoice_checkouts" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "checkout_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoice_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoice_checkouts_provider_ref_key" ON "platform_invoice_checkouts"("provider_ref");

-- CreateIndex
CREATE INDEX "platform_invoice_checkouts_invoice_id_idx" ON "platform_invoice_checkouts"("invoice_id");

-- AddForeignKey
ALTER TABLE "platform_invoice_checkouts" ADD CONSTRAINT "platform_invoice_checkouts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invoices issued before T-124 fall due 14 days after they were issued, like new ones.
UPDATE "platform_invoices" SET "due_on" = ("issued_at" AT TIME ZONE 'UTC')::date + 14 WHERE "due_on" IS NULL;
