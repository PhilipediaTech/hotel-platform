-- CreateTable
CREATE TABLE "generators" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tank_litres_milli" INTEGER NOT NULL,
    "service_every_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "generators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generator_runs" (
    "id" UUID NOT NULL,
    "generator_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "stopped_at" TIMESTAMPTZ(6),
    "started_by_id" UUID NOT NULL,
    "stopped_by_id" UUID,

    CONSTRAINT "generator_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_movements" (
    "id" UUID NOT NULL,
    "generator_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "litres_milli" INTEGER NOT NULL,
    "cost_minor" BIGINT,
    "supplier" TEXT,
    "file_id" UUID,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "meter" TEXT NOT NULL,
    "reading" BIGINT NOT NULL,
    "by_user_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "generators_asset_id_key" ON "generators"("asset_id");

-- CreateIndex
CREATE INDEX "generators_property_id_idx" ON "generators"("property_id");

-- CreateIndex
CREATE INDEX "generator_runs_generator_id_started_at_idx" ON "generator_runs"("generator_id", "started_at");

-- CreateIndex
CREATE INDEX "fuel_movements_generator_id_at_idx" ON "fuel_movements"("generator_id", "at");

-- CreateIndex
CREATE INDEX "meter_readings_property_id_meter_at_idx" ON "meter_readings"("property_id", "meter", "at");

-- AddForeignKey
ALTER TABLE "generators" ADD CONSTRAINT "generators_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generators" ADD CONSTRAINT "generators_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_generator_id_fkey" FOREIGN KEY ("generator_id") REFERENCES "generators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_stopped_by_id_fkey" FOREIGN KEY ("stopped_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_generator_id_fkey" FOREIGN KEY ("generator_id") REFERENCES "generators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules (T-132).
ALTER TABLE "generators" ADD CONSTRAINT "generators_amounts_check" CHECK (
  "tank_litres_milli" > 0 AND ("service_every_minutes" IS NULL OR "service_every_minutes" > 0)
);
ALTER TABLE "generator_runs" ADD CONSTRAINT "generator_runs_times_check" CHECK (
  "stopped_at" IS NULL OR "stopped_at" >= "started_at"
);
-- One run open per generator at a time.
CREATE UNIQUE INDEX "generator_runs_one_open" ON "generator_runs" ("generator_id") WHERE "stopped_at" IS NULL;
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_kind_check" CHECK (
  ("kind" IN ('RECEIVED', 'ISSUED') AND "litres_milli" > 0)
  OR ("kind" = 'LEVEL_CHECK' AND "litres_milli" >= 0 AND "cost_minor" IS NULL)
);
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_cost_check" CHECK (
  "cost_minor" IS NULL OR "cost_minor" >= 0
);
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_reading_check" CHECK ("reading" >= 0);
