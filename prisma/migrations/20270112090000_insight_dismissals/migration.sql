-- Maintenance insights (Versions V3 "maintenance anomaly insights"; T-180; Philip chose a
-- table for dismissals, 2026-11-27): an insight someone dismissed, with the reason. The key
-- names the insight, the fingerprint its evidence; a new fault, reading or level check makes
-- a new fingerprint, so the insight shows again.


-- CreateTable
CREATE TABLE "insight_dismissals" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insight_dismissals_property_id_key_fingerprint_key" ON "insight_dismissals"("property_id", "key", "fingerprint");

-- AddForeignKey
ALTER TABLE "insight_dismissals" ADD CONSTRAINT "insight_dismissals_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_dismissals" ADD CONSTRAINT "insight_dismissals_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "insight_dismissals"
  ADD CONSTRAINT "insight_dismissals_key_check" CHECK (length("key") BETWEEN 1 AND 200),
  ADD CONSTRAINT "insight_dismissals_fingerprint_check" CHECK (length("fingerprint") BETWEEN 1 AND 200),
  ADD CONSTRAINT "insight_dismissals_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);

-- Rows of one property (T-144).
ALTER TABLE "insight_dismissals" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "insight_dismissals"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
