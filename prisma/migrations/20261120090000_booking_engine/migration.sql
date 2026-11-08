-- CreateTable
CREATE TABLE "booking_engine_settings" (
    "property_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT,
    "description" TEXT,
    "policies" TEXT,
    "photo_file_ids" UUID[],
    "allow_pay_full" BOOLEAN NOT NULL DEFAULT true,
    "allow_deposit" BOOLEAN NOT NULL DEFAULT true,
    "deposit_bps" INTEGER NOT NULL DEFAULT 3000,
    "allow_pay_at_hotel" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "booking_engine_settings_pkey" PRIMARY KEY ("property_id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "discount_bps" INTEGER NOT NULL,
    "valid_from" DATE,
    "valid_to" DATE,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_links" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_key" UUID,
    "promo_code_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guest_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_engine_settings_slug_key" ON "booking_engine_settings"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_property_id_code_key" ON "promo_codes"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "guest_links_token_hash_key" ON "guest_links"("token_hash");

-- CreateIndex
CREATE INDEX "guest_links_reservation_id_idx" ON "guest_links"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_links_property_id_client_key_key" ON "guest_links"("property_id", "client_key");

-- AddForeignKey
ALTER TABLE "booking_engine_settings" ADD CONSTRAINT "booking_engine_settings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_links" ADD CONSTRAINT "guest_links_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_links" ADD CONSTRAINT "guest_links_property_id_reservation_id_fkey" FOREIGN KEY ("property_id", "reservation_id") REFERENCES "reservations"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

