-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "goods_receipt_id" UUID,
ADD COLUMN     "purchase_order_line_id" UUID;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "expected_on" DATE,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approval_request_id" UUID,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" TEXT,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_milli" BIGINT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "received_milli" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "supplier_ref" TEXT,
    "note" TEXT,
    "received_by_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_property_id_name_key" ON "suppliers"("property_id", "name");

-- CreateIndex
CREATE INDEX "purchase_orders_property_id_status_idx" ON "purchase_orders"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_property_id_number_key" ON "purchase_orders"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_purchase_order_id_item_id_key" ON "purchase_order_lines"("purchase_order_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_property_id_number_key" ON "goods_receipts"("property_id", "number");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_purchase_order_line_id_fkey" FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Rules (T-146; PRD M10-03, M10-04).
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "suppliers_email_check" CHECK ("email" IS NULL OR "email" ~ '^[^@\s]+@[^@\s]+$');

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_total_check" CHECK ("total_minor" >= 0),
  ADD CONSTRAINT "purchase_orders_approved_check" CHECK (
    ("status" IN ('DRAFT', 'CANCELLED')) OR ("approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL)),
  ADD CONSTRAINT "purchase_orders_closed_check" CHECK (
    ("status" IN ('CLOSED', 'CANCELLED')) = ("closed_at" IS NOT NULL)
    AND ("closed_at" IS NULL) = ("closed_by_id" IS NULL)
    AND ("status" = 'CLOSED') = ("close_reason" IS NOT NULL)
    AND ("close_reason" IS NULL OR length(btrim("close_reason")) BETWEEN 1 AND 500)),
  ADD CONSTRAINT "purchase_orders_note_check" CHECK ("note" IS NULL OR length("note") <= 500);
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_quantity_check" CHECK (
    "quantity_milli" > 0 AND "received_milli" BETWEEN 0 AND "quantity_milli"),
  ADD CONSTRAINT "purchase_order_lines_price_check" CHECK ("unit_price_minor" >= 0);
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_ref_check" CHECK (
    "supplier_ref" IS NULL OR length(btrim("supplier_ref")) BETWEEN 1 AND 60),
  ADD CONSTRAINT "goods_receipts_note_check" CHECK ("note" IS NULL OR length("note") <= 500);

-- A RECEIPT movement is one line of a goods receipt, nothing else.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  CASE "kind"
    WHEN 'RECEIPT' THEN "quantity_milli" > 0 AND "goods_receipt_id" IS NOT NULL
      AND "purchase_order_line_id" IS NOT NULL
    WHEN 'ISSUE' THEN "quantity_milli" < 0 AND "requisition_id" IS NOT NULL
      AND "requisition_line_id" IS NOT NULL
    WHEN 'TRANSFER' THEN "transfer_id" IS NOT NULL
    WHEN 'ADJUSTMENT' THEN "reason" IS NOT NULL
  END);

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'purchase_orders', 'purchase_order_lines',
    'goods_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;

-- M10-03: purchase orders above the raiser's limit need approval. New properties get this
-- policy when they are created; these are the ones that already exist (back office: 48 hours).
INSERT INTO "approval_policies" ("id", "organisation_id", "property_id", "action", "approver_role_ids", "expiry_minutes")
SELECT gen_random_uuid(), p."organisation_id", p."id", 'po.approve',
       COALESCE((SELECT array_agg(r."id") FROM "roles" r
                 WHERE r."organisation_id" = p."organisation_id"
                   AND r."name" IN ('Owner', 'General Manager')), '{}'),
       2880
FROM "properties" p
ON CONFLICT ("property_id", "action") DO NOTHING;
