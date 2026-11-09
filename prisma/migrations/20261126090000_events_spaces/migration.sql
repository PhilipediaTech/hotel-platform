-- CreateTable
CREATE TABLE "spaces" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "setup_minutes" INTEGER NOT NULL DEFAULT 0,
    "cleanup_minutes" INTEGER NOT NULL DEFAULT 0,
    "minimum_hire_minor" BIGINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_layouts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "space_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_rate_rules" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "day_type" TEXT NOT NULL DEFAULT 'ALL',
    "season_from" DATE,
    "season_to" DATE,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "space_rate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_enquiries" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "event_type" TEXT NOT NULL,
    "event_date" DATE,
    "expected_guests" INTEGER,
    "notes" TEXT,
    "lost_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "event_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_bookings" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "enquiry_id" UUID,
    "space_id" UUID NOT NULL,
    "layout_id" UUID,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_from" TIMESTAMPTZ(6) NOT NULL,
    "blocked_until" TIMESTAMPTZ(6) NOT NULL,
    "expected_guests" INTEGER NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spaces_property_id_code_key" ON "spaces"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "space_layouts_space_id_name_key" ON "space_layouts"("space_id", "name");

-- CreateIndex
CREATE INDEX "space_rate_rules_space_id_idx" ON "space_rate_rules"("space_id");

-- CreateIndex
CREATE INDEX "event_enquiries_property_id_status_created_at_idx" ON "event_enquiries"("property_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "event_bookings_property_id_blocked_from_idx" ON "event_bookings"("property_id", "blocked_from");

-- CreateIndex
CREATE INDEX "event_bookings_status_hold_expires_at_idx" ON "event_bookings"("status", "hold_expires_at");

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_layouts" ADD CONSTRAINT "space_layouts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_rate_rules" ADD CONSTRAINT "space_rate_rules_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_enquiries" ADD CONSTRAINT "event_enquiries_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_enquiries" ADD CONSTRAINT "event_enquiries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "event_enquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "space_layouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M9 rules: no two bookings may overlap on a space, including buffers. Holds past their time
-- stay in this constraint until they are marked EXPIRED, which happens before each new hold.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "event_bookings"
  ADD CONSTRAINT "event_bookings_no_overlap"
  EXCLUDE USING gist (
    "space_id" WITH =,
    tstzrange("blocked_from", "blocked_until", '[)') WITH &&
  ) WHERE ("status" IN ('HOLD', 'CONFIRMED'));

ALTER TABLE "event_bookings"
  ADD CONSTRAINT "event_bookings_status_check" CHECK ("status" IN ('HOLD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),
  ADD CONSTRAINT "event_bookings_times_check" CHECK ("ends_at" > "starts_at" AND "blocked_from" <= "starts_at" AND "blocked_until" >= "ends_at"),
  ADD CONSTRAINT "event_bookings_guests_check" CHECK ("expected_guests" > 0);
ALTER TABLE "event_enquiries"
  ADD CONSTRAINT "event_enquiries_status_check" CHECK ("status" IN ('OPEN', 'WON', 'LOST'));
ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_amounts_check" CHECK ("setup_minutes" >= 0 AND "cleanup_minutes" >= 0 AND "minimum_hire_minor" >= 0);
ALTER TABLE "space_layouts"
  ADD CONSTRAINT "space_layouts_capacity_check" CHECK ("capacity" > 0);
ALTER TABLE "space_rate_rules"
  ADD CONSTRAINT "space_rate_rules_unit_check" CHECK ("unit" IN ('HOURLY', 'HALF_DAY', 'FULL_DAY', 'EXTRA')),
  ADD CONSTRAINT "space_rate_rules_day_type_check" CHECK ("day_type" IN ('ALL', 'WEEKDAY', 'WEEKEND')),
  ADD CONSTRAINT "space_rate_rules_amount_check" CHECK ("amount_minor" >= 0);
