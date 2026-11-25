-- CreateTable
CREATE TABLE "service_requests" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "stay_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "task_id" UUID NOT NULL,
    "client_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_task_id_key" ON "service_requests"("task_id");

-- CreateIndex
CREATE INDEX "service_requests_reservation_id_created_at_idx" ON "service_requests"("reservation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_property_id_client_key_key" ON "service_requests"("property_id", "client_key");

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_property_id_stay_id_fkey" FOREIGN KEY ("property_id", "stay_id") REFERENCES "stays"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "service_requests"
  ADD CONSTRAINT "service_requests_kind_check" CHECK ("kind" IN ('HOUSEKEEPING', 'AMENITIES', 'MAINTENANCE', 'FOOD_DRINK', 'TRANSPORT', 'OTHER')),
  ADD CONSTRAINT "service_requests_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);

-- A guest can also start their review from their link after the stay (T-159).
ALTER TABLE "guest_reviews" DROP CONSTRAINT "guest_reviews_channel_check";
ALTER TABLE "guest_reviews"
  ADD CONSTRAINT "guest_reviews_channel_check" CHECK ("channel" IN ('EMAIL', 'WHATSAPP', 'PORTAL'));

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "service_requests" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "service_requests"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
