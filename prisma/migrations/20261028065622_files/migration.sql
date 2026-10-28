-- CreateEnum
CREATE TYPE "FileScan" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "scan" "FileScan" NOT NULL DEFAULT 'PENDING',
    "entity_type" TEXT,
    "entity_id" TEXT,
    "retention_class" TEXT NOT NULL DEFAULT 'STANDARD',
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "files_property_id_entity_type_entity_id_idx" ON "files"("property_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL (T-023)
ALTER TABLE "files"
  -- Per-kind limits are in FILE_KINDS; this is the ceiling for any kind.
  ADD CONSTRAINT "files_size_check" CHECK ("size_bytes" BETWEEN 1 AND 26214400),
  ADD CONSTRAINT "files_content_type_check" CHECK ("content_type" ~ '^[a-z]+/[a-z0-9.+-]+$'),
  ADD CONSTRAINT "files_retention_class_check" CHECK ("retention_class" IN ('STANDARD')),
  -- A file is linked to a record only together with the record's kind.
  ADD CONSTRAINT "files_entity_check" CHECK ("entity_id" IS NULL OR "entity_type" IS NOT NULL);

-- The scan job looks for files waiting for their scan, oldest first.
CREATE INDEX "files_pending_scan_idx" ON "files" ("created_at") WHERE "scan" = 'PENDING';
