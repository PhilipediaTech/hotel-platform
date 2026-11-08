-- The visitor register (PRD M14-04, M14-05; T-057).

-- CreateTable
CREATE TABLE "visitors" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "note" TEXT,
    "id_file_id" UUID,
    "purge_after" DATE,
    "signed_in_by_id" UUID NOT NULL,
    "signed_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_out_by_id" UUID,
    "signed_out_at" TIMESTAMPTZ(6),

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitors_property_id_signed_out_at_idx" ON "visitors"("property_id", "signed_out_at");

-- CreateIndex
CREATE INDEX "visitors_property_id_signed_in_at_idx" ON "visitors"("property_id", "signed_in_at");

-- CreateIndex
CREATE INDEX "visitors_stay_id_idx" ON "visitors"("stay_id");

-- CreateIndex
CREATE INDEX "visitors_purge_after_idx" ON "visitors"("purge_after");

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_id_file_id_fkey" FOREIGN KEY ("id_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_signed_in_by_id_fkey" FOREIGN KEY ("signed_in_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_signed_out_by_id_fkey" FOREIGN KEY ("signed_out_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Sign-out says who and when; the name is not blank.
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_signed_out_check"
  CHECK (("signed_out_at" IS NULL) = ("signed_out_by_id" IS NULL));
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_name_check"
  CHECK (length(trim("name")) > 0);
