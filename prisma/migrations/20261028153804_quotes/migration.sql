-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "arrival" DATE NOT NULL,
    "departure" DATE NOT NULL,
    "nights" JSONB NOT NULL,
    "taxes" JSONB NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_property_id_expires_at_idx" ON "quotes"("property_id", "expires_at");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_rate_plan_id_fkey" FOREIGN KEY ("property_id", "rate_plan_id") REFERENCES "rate_plans"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-041) ──────────────────────────────────────────

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_dates_check" CHECK (departure > arrival),
  ADD CONSTRAINT "quotes_total_check" CHECK (total_minor >= 0);
