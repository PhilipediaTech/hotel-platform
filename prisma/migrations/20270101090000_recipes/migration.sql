-- AlterEnum
ALTER TYPE "StockMovementKind" ADD VALUE 'SALE';

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "stock_location_id" UUID;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "pos_order_line_id" UUID;

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_lines" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity_milli" BIGINT NOT NULL,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_menu_item_id_key" ON "recipes"("menu_item_id");

-- CreateIndex
CREATE INDEX "recipe_lines_property_id_stock_item_id_idx" ON "recipe_lines"("property_id", "stock_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_recipe_id_stock_item_id_key" ON "recipe_lines"("recipe_id", "stock_item_id");

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_stock_location_id_fkey" FOREIGN KEY ("stock_location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_pos_order_line_id_fkey" FOREIGN KEY ("pos_order_line_id") REFERENCES "pos_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A SALE movement takes stock out for one POS order line (its recipe), with its reason.
-- Compared as text: the new enum value can't be named in the transaction that adds it.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_check";
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (
  CASE "kind"::text
    WHEN 'RECEIPT' THEN "quantity_milli" > 0 AND "goods_receipt_id" IS NOT NULL
      AND "purchase_order_line_id" IS NOT NULL
    WHEN 'ISSUE' THEN "quantity_milli" < 0 AND "requisition_id" IS NOT NULL
      AND "requisition_line_id" IS NOT NULL
    WHEN 'TRANSFER' THEN "transfer_id" IS NOT NULL
    WHEN 'ADJUSTMENT' THEN "reason" IS NOT NULL
    WHEN 'SALE' THEN "quantity_milli" < 0 AND "pos_order_line_id" IS NOT NULL
      AND "reason" IS NOT NULL
  END);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sale_line_check" CHECK (
  "pos_order_line_id" IS NULL OR "kind"::text = 'SALE');

ALTER TABLE "recipe_lines"
  ADD CONSTRAINT "recipe_lines_quantity_check" CHECK ("quantity_milli" > 0 AND "quantity_milli" <= 1000000000);

-- Row-level security (T-144): every tenant table has its policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipes', 'recipe_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I
      USING (app_property_id() IS NULL OR "property_id" = app_property_id())
      WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id())', t);
  END LOOP;
END $$;
