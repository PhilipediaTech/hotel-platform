-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" BIGINT NOT NULL,
    "pricing" TEXT NOT NULL DEFAULT 'PER_BOOKING',
    "duration_minutes" INTEGER NOT NULL,
    "capacity" INTEGER,
    "opens_at" TEXT NOT NULL,
    "closes_at" TEXT NOT NULL,
    "min_notice_minutes" INTEGER NOT NULL DEFAULT 0,
    "max_advance_days" INTEGER NOT NULL DEFAULT 30,
    "charge_to_folio" BOOLEAN NOT NULL DEFAULT true,
    "revenue_code_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_bookings" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "stay_id" UUID,
    "guest_name" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "folio_line_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "services_property_id_code_key" ON "services"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "service_bookings_folio_line_id_key" ON "service_bookings"("folio_line_id");

-- CreateIndex
CREATE INDEX "service_bookings_service_id_starts_at_idx" ON "service_bookings"("service_id", "starts_at");

-- CreateIndex
CREATE INDEX "service_bookings_property_id_starts_at_idx" ON "service_bookings"("property_id", "starts_at");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_revenue_code_id_fkey" FOREIGN KEY ("revenue_code_id") REFERENCES "revenue_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_bookings" ADD CONSTRAINT "service_bookings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_bookings" ADD CONSTRAINT "service_bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_bookings" ADD CONSTRAINT "service_bookings_stay_id_fkey" FOREIGN KEY ("stay_id") REFERENCES "stays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_bookings" ADD CONSTRAINT "service_bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "services"
  ADD CONSTRAINT "services_category_check" CHECK ("category" IN ('LAUNDRY', 'PARKING', 'TRANSFER', 'SPA', 'GYM', 'TOUR', 'OTHER')),
  ADD CONSTRAINT "services_pricing_check" CHECK ("pricing" IN ('PER_BOOKING', 'PER_PERSON', 'PER_HOUR')),
  ADD CONSTRAINT "services_numbers_check" CHECK ("price_minor" >= 0 AND "duration_minutes" > 0 AND ("capacity" IS NULL OR "capacity" > 0) AND "min_notice_minutes" >= 0 AND "max_advance_days" >= 0 AND "opens_at" < "closes_at");
ALTER TABLE "service_bookings"
  ADD CONSTRAINT "service_bookings_status_check" CHECK ("status" IN ('BOOKED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  ADD CONSTRAINT "service_bookings_numbers_check" CHECK ("quantity" > 0 AND "amount_minor" >= 0 AND "ends_at" > "starts_at");
