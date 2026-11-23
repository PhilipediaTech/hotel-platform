-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('SUBMITTED', 'PARTIAL', 'ISSUED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('COUNTING', 'POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "stock_units" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit_id" UUID NOT NULL,
    "par_milli" BIGINT,
    "reorder_milli" BIGINT,
    "unit_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity_milli" BIGINT NOT NULL,
    "unit_cost_minor" BIGINT NOT NULL,
    "reason" TEXT,
    "transfer_id" UUID,
    "requisition_id" UUID,
    "requisition_line_id" UUID,
    "stocktake_id" UUID,
    "by_user_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "approved_by_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "department_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" TEXT,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_milli" BIGINT NOT NULL,
    "issued_milli" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "requisition_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "location_id" UUID NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'COUNTING',
    "started_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(6),
    "reason" TEXT,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "counted_milli" BIGINT,
    "counted_by_id" UUID,
    "counted_at" TIMESTAMPTZ(6),
    "expected_milli" BIGINT,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_units_property_id_code_key" ON "stock_units"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_property_id_code_key" ON "stock_locations"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_property_id_code_key" ON "stock_items"("property_id", "code");

-- CreateIndex
CREATE INDEX "stock_movements_property_id_item_id_location_id_idx" ON "stock_movements"("property_id", "item_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_movements_property_id_at_idx" ON "stock_movements"("property_id", "at");

-- CreateIndex
CREATE INDEX "requisitions_property_id_status_idx" ON "requisitions"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "requisitions_property_id_number_key" ON "requisitions"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_lines_requisition_id_item_id_key" ON "requisition_lines"("requisition_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_property_id_number_key" ON "stocktakes"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_stocktake_id_item_id_key" ON "stocktake_lines"("stocktake_id", "item_id");

-- AddForeignKey
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "stock_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_requisition_line_id_fkey" FOREIGN KEY ("requisition_line_id") REFERENCES "requisition_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lines" ADD CONSTRAINT "requisition_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_counted_by_id_fkey" FOREIGN KEY ("counted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-145; PRD M10-01, M10-02, M10-05 and M10 rules).
ALTER TABLE "stock_units"
  ADD CONSTRAINT "stock_units_code_check" CHECK ("code" ~ '^[A-Z0-9-]{1,12}$'),
  ADD CONSTRAINT "stock_units_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 40);
ALTER TABLE "stock_locations"
  ADD CONSTRAINT "stock_locations_code_check" CHECK ("code" ~ '^[A-Z0-9-]{2,12}$'),
  ADD CONSTRAINT "stock_locations_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_code_check" CHECK ("code" ~ '^[A-Z0-9-]{2,20}$'),
  ADD CONSTRAINT "stock_items_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "stock_items_levels_check" CHECK (
    ("par_milli" IS NULL OR "par_milli" >= 0)
    AND ("reorder_milli" IS NULL OR "reorder_milli" >= 0)
    AND ("par_milli" IS NULL OR "reorder_milli" IS NULL OR "reorder_milli" <= "par_milli")),
  ADD CONSTRAINT "stock_items_cost_check" CHECK ("unit_cost_minor" >= 0);

-- Stock on hand is the sum of movements, never edited (M10 rule): movements are append-only,
-- in is positive and out negative, and each kind carries what it needs.
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_quantity_check" CHECK ("quantity_milli" <> 0),
  ADD CONSTRAINT "stock_movements_cost_check" CHECK ("unit_cost_minor" >= 0),
  ADD CONSTRAINT "stock_movements_kind_check" CHECK (
    CASE "kind"
      WHEN 'RECEIPT' THEN "quantity_milli" > 0
      WHEN 'ISSUE' THEN "quantity_milli" < 0 AND "requisition_id" IS NOT NULL
        AND "requisition_line_id" IS NOT NULL
      WHEN 'TRANSFER' THEN "transfer_id" IS NOT NULL
      WHEN 'ADJUSTMENT' THEN "reason" IS NOT NULL
    END),
  -- Every issue has a requester and an approver, and they are not the same person.
  ADD CONSTRAINT "stock_movements_issue_check" CHECK (
    "kind" <> 'ISSUE' OR ("requested_by_id" IS NOT NULL AND "approved_by_id" IS NOT NULL
      AND "requested_by_id" <> "approved_by_id")),
  ADD CONSTRAINT "stock_movements_reason_check" CHECK (
    "reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 500);
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE "requisitions"
  ADD CONSTRAINT "requisitions_closed_check" CHECK (
    ("status" IN ('CLOSED', 'CANCELLED')) = ("closed_at" IS NOT NULL)
    AND ("closed_at" IS NULL) = ("closed_by_id" IS NULL)),
  ADD CONSTRAINT "requisitions_reason_check" CHECK (
    ("status" = 'CLOSED') = ("close_reason" IS NOT NULL)
    AND ("close_reason" IS NULL OR length(btrim("close_reason")) BETWEEN 1 AND 500)),
  ADD CONSTRAINT "requisitions_note_check" CHECK ("note" IS NULL OR length("note") <= 500);
ALTER TABLE "requisition_lines"
  ADD CONSTRAINT "requisition_lines_quantity_check" CHECK (
    "quantity_milli" > 0 AND "issued_milli" BETWEEN 0 AND "quantity_milli");

ALTER TABLE "stocktakes"
  ADD CONSTRAINT "stocktakes_posted_check" CHECK (
    ("status" = 'POSTED') = ("posted_at" IS NOT NULL)
    AND ("posted_at" IS NULL) = ("posted_by_id" IS NULL)),
  ADD CONSTRAINT "stocktakes_reason_check" CHECK (
    "reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 500);
-- One count of a location at a time.
CREATE UNIQUE INDEX "stocktakes_one_counting" ON "stocktakes" ("location_id")
  WHERE "status" = 'COUNTING';
ALTER TABLE "stocktake_lines"
  ADD CONSTRAINT "stocktake_lines_counted_check" CHECK (
    ("counted_milli" IS NULL OR "counted_milli" >= 0)
    AND ("counted_milli" IS NULL) = ("counted_at" IS NULL)
    AND ("counted_at" IS NULL) = ("counted_by_id" IS NULL));

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_units', 'stock_locations', 'stock_items', 'stock_movements',
    'requisitions', 'requisition_lines', 'stocktakes', 'stocktake_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;
