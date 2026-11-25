-- CreateTable
CREATE TABLE "einvoice_submissions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "window_id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "irn" TEXT,
    "qr_data" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "einvoice_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_submissions_window_id_key" ON "einvoice_submissions"("window_id");

-- CreateIndex
CREATE INDEX "einvoice_submissions_property_id_status_next_attempt_at_idx" ON "einvoice_submissions"("property_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_submissions_property_id_invoice_number_key" ON "einvoice_submissions"("property_id", "invoice_number");

-- AddForeignKey
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_property_id_folio_id_fkey" FOREIGN KEY ("property_id", "folio_id") REFERENCES "folios"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "folio_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "einvoice_submissions"
  ADD CONSTRAINT "einvoice_submissions_status_check" CHECK ("status" IN ('QUEUED', 'ACCEPTED', 'REJECTED', 'FAILED')),
  ADD CONSTRAINT "einvoice_submissions_accepted_check" CHECK (("status" = 'ACCEPTED') = ("irn" IS NOT NULL AND "accepted_at" IS NOT NULL)),
  ADD CONSTRAINT "einvoice_submissions_queued_check" CHECK (("status" = 'QUEUED') = ("next_attempt_at" IS NOT NULL)),
  ADD CONSTRAINT "einvoice_submissions_attempts_check" CHECK ("attempts" >= 0);

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "einvoice_submissions" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "einvoice_submissions"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
