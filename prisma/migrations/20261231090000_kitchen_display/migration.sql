-- AlterTable
ALTER TABLE "menu_categories" ADD COLUMN     "kitchen_station" TEXT;

-- AlterTable
ALTER TABLE "pos_order_lines" ADD COLUMN     "kitchen_station" TEXT,
ADD COLUMN     "kitchen_ticket_id" UUID;

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "station" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_by_id" UUID NOT NULL,
    "bumped_at" TIMESTAMPTZ(6),
    "bumped_by_id" UUID,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kitchen_tickets_property_id_outlet_id_station_bumped_at_idx" ON "kitchen_tickets"("property_id", "outlet_id", "station", "bumped_at");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_tickets_order_id_number_key" ON "kitchen_tickets"("order_id", "number");

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_kitchen_ticket_id_fkey" FOREIGN KEY ("kitchen_ticket_id") REFERENCES "kitchen_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_bumped_by_id_fkey" FOREIGN KEY ("bumped_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules the application keeps, kept by the database too.
ALTER TABLE "menu_categories"
  ADD CONSTRAINT "menu_categories_kitchen_station_check" CHECK ("kitchen_station" IS NULL OR char_length(btrim("kitchen_station")) BETWEEN 1 AND 30);
ALTER TABLE "pos_order_lines"
  ADD CONSTRAINT "pos_order_lines_kitchen_check" CHECK ("kitchen_ticket_id" IS NULL OR "kitchen_station" IS NOT NULL);
ALTER TABLE "kitchen_tickets"
  ADD CONSTRAINT "kitchen_tickets_number_check" CHECK ("number" >= 1),
  ADD CONSTRAINT "kitchen_tickets_bumped_check" CHECK (("bumped_at" IS NULL) = ("bumped_by_id" IS NULL));

-- Row-level security (T-144): every tenant table has its policy.
ALTER TABLE "kitchen_tickets" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "kitchen_tickets"
  USING (app_property_id() IS NULL OR "property_id" = app_property_id())
  WITH CHECK (app_property_id() IS NULL OR "property_id" = app_property_id());
