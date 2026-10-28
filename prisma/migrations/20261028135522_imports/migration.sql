-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_property_id_created_at_idx" ON "import_jobs"("property_id", "created_at");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-034) ──────────────────────────────────────────

ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_kind_check"
    CHECK (kind IN ('ROOMS', 'RATES', 'GUESTS', 'COMPANIES', 'BALANCES')),
  ADD CONSTRAINT "import_jobs_status_check" CHECK (status IN ('VALIDATED', 'FAILED', 'APPLIED'));
