-- AlterTable
ALTER TABLE "files" ALTER COLUMN "uploaded_by_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "online_check_ins" (
    "stay_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "details" JSONB NOT NULL,
    "id_number_enc" BYTEA,
    "id_file_id" UUID,
    "arrival_time" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "purge_after" DATE NOT NULL,

    CONSTRAINT "online_check_ins_pkey" PRIMARY KEY ("stay_id")
);

-- CreateIndex
CREATE INDEX "online_check_ins_purge_after_idx" ON "online_check_ins"("purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "online_check_ins_property_id_stay_id_key" ON "online_check_ins"("property_id", "stay_id");

-- AddForeignKey
ALTER TABLE "online_check_ins" ADD CONSTRAINT "online_check_ins_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_check_ins" ADD CONSTRAINT "online_check_ins_id_file_id_fkey" FOREIGN KEY ("id_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

