-- CreateEnum
CREATE TYPE "rate_plan_kind" AS ENUM ('BAR', 'DERIVED', 'PACKAGE', 'DAY_USE', 'NEGOTIATED');

-- CreateEnum
CREATE TYPE "guarantee" AS ENUM ('NONE', 'DEPOSIT', 'CARD_ON_FILE', 'COMPANY');

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "no_show_fee" JSONB NOT NULL,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "rate_plan_kind" NOT NULL,
    "parent_rate_plan_id" UUID,
    "derivation_bps" INTEGER,
    "derivation_amount_minor" BIGINT,
    "rounding_minor" BIGINT NOT NULL DEFAULT 10000,
    "floor_minor" BIGINT,
    "meal_plan" TEXT NOT NULL DEFAULT 'ROOM_ONLY',
    "cancellation_policy_id" UUID NOT NULL,
    "guarantee" "guarantee" NOT NULL DEFAULT 'NONE',
    "currency" CHAR(3) NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "company_id" UUID,
    "day_use_max_minutes" INTEGER,
    "room_type_ids" UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_days" (
    "property_id" UUID NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount_minor" BIGINT,
    "min_stay" INTEGER,
    "max_stay" INTEGER,
    "closed_to_arrival" BOOLEAN NOT NULL DEFAULT false,
    "closed_to_departure" BOOLEAN NOT NULL DEFAULT false,
    "stop_sell" BOOLEAN NOT NULL DEFAULT false,
    "rule_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_days_pkey" PRIMARY KEY ("rate_plan_id","room_type_id","date")
);

-- CreateTable
CREATE TABLE "package_components" (
    "id" UUID NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "revenue_code_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "per_person" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "package_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_policies_property_id_id_key" ON "cancellation_policies"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_code_key" ON "rate_plans"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_id_key" ON "rate_plans"("property_id", "id");

-- CreateIndex
CREATE INDEX "rate_days_property_id_date_idx" ON "rate_days"("property_id", "date");

-- CreateIndex
CREATE INDEX "package_components_rate_plan_id_idx" ON "package_components"("rate_plan_id");

-- AddForeignKey
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organisation_id_property_id_fkey" FOREIGN KEY ("organisation_id", "property_id") REFERENCES "properties"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_property_id_cancellation_policy_id_fkey" FOREIGN KEY ("property_id", "cancellation_policy_id") REFERENCES "cancellation_policies"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_parent_rate_plan_id_fkey" FOREIGN KEY ("parent_rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_rate_plan_id_fkey" FOREIGN KEY ("property_id", "rate_plan_id") REFERENCES "rate_plans"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_components" ADD CONSTRAINT "package_components_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_components" ADD CONSTRAINT "package_components_revenue_code_id_fkey" FOREIGN KEY ("revenue_code_id") REFERENCES "revenue_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Constraints Prisma can't express (T-033) ──────────────────────────────────────────

ALTER TABLE "rate_plans"
  ADD CONSTRAINT "rate_plans_parent_check" CHECK (
    (kind = 'DERIVED' AND parent_rate_plan_id IS NOT NULL)
    OR (kind = 'BAR' AND parent_rate_plan_id IS NULL)
    OR kind IN ('PACKAGE', 'DAY_USE', 'NEGOTIATED')),
  ADD CONSTRAINT "rate_plans_not_own_parent_check" CHECK (parent_rate_plan_id <> id),
  ADD CONSTRAINT "rate_plans_derivation_check"
    CHECK (derivation_bps IS NULL OR derivation_bps BETWEEN -10000 AND 10000),
  ADD CONSTRAINT "rate_plans_rounding_check" CHECK (rounding_minor >= 1),
  ADD CONSTRAINT "rate_plans_floor_check" CHECK (floor_minor IS NULL OR floor_minor >= 0),
  ADD CONSTRAINT "rate_plans_day_use_check" CHECK (
    (kind = 'DAY_USE') = (day_use_max_minutes IS NOT NULL)
    AND (day_use_max_minutes IS NULL OR day_use_max_minutes BETWEEN 30 AND 1440));

ALTER TABLE "rate_days"
  ADD CONSTRAINT "rate_days_amount_check" CHECK (amount_minor IS NULL OR amount_minor >= 0),
  ADD CONSTRAINT "rate_days_stay_check" CHECK (
    (min_stay IS NULL OR min_stay BETWEEN 1 AND 365)
    AND (max_stay IS NULL OR max_stay BETWEEN 1 AND 365)
    AND (min_stay IS NULL OR max_stay IS NULL OR max_stay >= min_stay));

ALTER TABLE "package_components"
  ADD CONSTRAINT "package_components_amount_check" CHECK (amount_minor >= 0);
