-- Occupants added to stays and extra-person charge suggestions on rate plans (PRD M14-02,
-- M14-03; T-056).

-- CreateEnum
CREATE TYPE "occupant_kind" AS ENUM ('ADULT', 'CHILD');

-- AlterTable
ALTER TABLE "rate_plans" ADD COLUMN     "extra_adult_minor" BIGINT,
ADD COLUMN     "extra_child_minor" BIGINT;

-- CreateTable
CREATE TABLE "stay_occupants" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "kind" "occupant_kind" NOT NULL,
    "phone" TEXT,
    "nightly_charge_minor" BIGINT NOT NULL DEFAULT 0,
    "charge_note" TEXT,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_by_id" UUID,
    "removed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stay_occupants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stay_occupants_stay_id_idx" ON "stay_occupants"("stay_id");

-- AddForeignKey
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Charges are never negative; a removed occupant says who removed them and when; names are
-- not blank.
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_extra_charges_check"
  CHECK (("extra_adult_minor" IS NULL OR "extra_adult_minor" >= 0)
     AND ("extra_child_minor" IS NULL OR "extra_child_minor" >= 0));
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_charge_check"
  CHECK ("nightly_charge_minor" >= 0);
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_removed_check"
  CHECK (("removed_at" IS NULL) = ("removed_by_id" IS NULL));
ALTER TABLE "stay_occupants" ADD CONSTRAINT "stay_occupants_names_check"
  CHECK (length(trim("first_name")) > 0 AND length(trim("last_name")) > 0);
