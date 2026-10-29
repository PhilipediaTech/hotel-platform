-- CreateEnum
CREATE TYPE "day_status" AS ENUM ('OPEN', 'AUDITING', 'CLOSED');

-- CreateTable
CREATE TABLE "business_days" (
    "property_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "day_status" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_id" UUID,

    CONSTRAINT "business_days_pkey" PRIMARY KEY ("property_id","date")
);

-- AddForeignKey
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_days" ADD CONSTRAINT "business_days_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One open (or auditing) business day per property at a time.
CREATE UNIQUE INDEX "business_days_one_open" ON "business_days" ("property_id")
  WHERE "status" <> 'CLOSED';

-- A closed day has its closing time.
ALTER TABLE "business_days"
  ADD CONSTRAINT "business_days_closed_check" CHECK ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL);

-- Live properties trade from today at the property.
INSERT INTO "business_days" ("property_id", "date", "status")
SELECT "id", (now() AT TIME ZONE "time_zone")::date, 'OPEN'
FROM "properties"
WHERE "status" = 'LIVE';
