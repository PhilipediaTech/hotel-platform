-- CreateTable
CREATE TABLE "usage_counters" (
    "organisation_id" UUID NOT NULL,
    "month" CHAR(7) NOT NULL,
    "metric" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("organisation_id","month","metric")
);

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

